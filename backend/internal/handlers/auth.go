package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/auth"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/mailer"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Roles. Kept in sync with the CHECK constraint in migration 0010.
const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleEditor = "editor"
	RoleViewer = "viewer"
)

// Self-hosted plan projection. Spatial Map has no billing, trials or
// quotas, so every tenant reports the same neutral values. The fields stay
// on AuthTenant so API clients written against the old shape keep parsing.
const (
	// SelfHostedPlan is the only value AuthTenant.Plan ever carries.
	SelfHostedPlan = "self-hosted"
	// SelfHostedSubscriptionStatus is the only value
	// AuthTenant.SubscriptionStatus ever carries.
	SelfHostedSubscriptionStatus = "active"
)

// emailRegex is intentionally permissive — RFC 5322 is too strict for UX.
// We just want to catch obviously broken input; real validation happens
// when the user actually tries to log in.
var emailRegex = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

const (
	// OTP tuning. otpLifetime intentionally short — long enough for a
	// mailbox that's slow to deliver, short enough that a leaked code
	// stops mattering quickly.
	otpLifetime    = 10 * time.Minute
	otpMaxAttempts = 5

	// verificationTokenLifetime is the window between "code verified"
	// and "password set". Users get a short JWT they hand back to the
	// complete-signup endpoint. Deliberately short so a leaked mid-flow
	// token can't be replayed hours later.
	verificationTokenLifetime = 15 * time.Minute
	verificationTokenScope    = "signup"
	// resetTokenScope tags the token minted by /password-reset-verify so
	// it can't be replayed against /complete-signup (or vice versa).
	resetTokenScope = "password_reset"

	otpPurposeSignup = "signup"
	otpPurposeReset  = "password_reset"
)

// Machine-readable error codes for the /auth/* endpoints (api.Response.Code).
// The SPA maps each to a translated message in src/lib/auth-errors.ts — keep
// the two lists in sync. api.CodeRateLimited covers every 429.
const (
	codeInvalidRequest      = "invalid_request"
	codeInvalidEmail        = "invalid_email"
	codeOTPExpired          = "otp_expired"
	codeOTPLocked           = "otp_locked"
	codeOTPIncorrect        = "otp_incorrect"
	codeVerificationExpired = "verification_expired"
	codeEmailTaken          = "email_taken"
	codeEmailDisposable     = "email_disposable"
	codePasswordWeak        = "password_weak"
	codeInvalidCredentials  = "invalid_credentials"
	codeNotAuthenticated    = "not_authenticated"
)

// ---- Request / response types ----------------------------------------------

// SignupRequestBody is POST /auth/signup-request — start of the 3-step flow.
type SignupRequestBody struct {
	Email string `json:"email"`
}

// VerifyOTPBody is POST /auth/verify-otp.
type VerifyOTPBody struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

// VerifyOTPResponse hands back a short-lived verification token that the
// next step (complete-signup) must present. Deliberately separate from
// the main login JWT so a stolen token can't be used to authenticate.
type VerifyOTPResponse struct {
	VerificationToken string `json:"verificationToken"`
	Email             string `json:"email"`
	ExpiresAt         string `json:"expiresAt"`
}

// CompleteSignupBody is POST /auth/complete-signup.
type CompleteSignupBody struct {
	Email             string `json:"email"`
	Password          string `json:"password"`
	VerificationToken string `json:"verificationToken"`
	DisplayName       string `json:"displayName"`
}

// PasswordResetRequestBody is POST /auth/password-reset-request.
type PasswordResetRequestBody struct {
	Email string `json:"email"`
}

// PasswordResetVerifyResponse hands back the short-lived token that
// /password-reset-complete must present. Scoped "password_reset".
type PasswordResetVerifyResponse struct {
	ResetToken string `json:"resetToken"`
	Email      string `json:"email"`
	ExpiresAt  string `json:"expiresAt"`
}

// PasswordResetCompleteBody is POST /auth/password-reset-complete.
type PasswordResetCompleteBody struct {
	Email      string `json:"email"`
	Password   string `json:"password"`
	ResetToken string `json:"resetToken"`
}

// AuthLoginRequest is the body for POST /api/v1/auth/login.
type AuthLoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// AuthUser is the public user representation returned to the client.
// Password hash is never serialized. Profile fields are always present but
// default to empty strings — the client decides what to render.
type AuthUser struct {
	ID          int64  `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Bio         string `json:"bio"`
	Location    string `json:"location"`
	Pronouns    string `json:"pronouns"`
	JobTitle    string `json:"jobTitle"`
	AvatarUrl   string `json:"avatarUrl"`
	VerifiedAt  string `json:"verifiedAt,omitempty"`
	/** True when this user's email matches SGV_AUTH.BOOTSTRAP_EMAIL — the
	 *  platform-level admin. Unlocks the /api/v1/admin/* surface + the
	 *  admin metrics section on /dashboard. Comparison is
	 *  case-insensitive because emails are stored lowercased on signup
	 *  but the config value may be typed as the user prefers. */
	IsPlatformAdmin bool `json:"isPlatformAdmin"`
}

// platformAdminEmail is the configured bootstrap owner address. Set
// once at boot via SetPlatformAdminEmail, then treated as a runtime
// constant. Comparison is case-insensitive because emails land
// lowercased at signup but the config value may not be.
var platformAdminEmail string

// SetPlatformAdminEmail stores the bootstrap admin email so the auth
// + admin handlers can flag it on responses without threading it
// through every constructor. Called once from main() after config
// load.
func SetPlatformAdminEmail(email string) {
	platformAdminEmail = strings.TrimSpace(email)
}

// IsPlatformAdminEmail reports whether the given email matches the
// configured bootstrap owner. False when no bootstrap is set.
func IsPlatformAdminEmail(email string) bool {
	if platformAdminEmail == "" {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(email), platformAdminEmail)
}

// toAuthUser projects a db.User row into the public AuthUser shape.
func toAuthUser(u db.User) AuthUser {
	out := AuthUser{
		ID:          u.ID,
		Email:       u.Email,
		DisplayName: u.DisplayName,
		Bio:         u.Bio,
		Location:    u.Location,
		Pronouns:    u.Pronouns,
		JobTitle:    u.JobTitle,
		AvatarUrl:   u.AvatarUrl,
	}
	if u.VerifiedAt.Valid {
		out.VerifiedAt = u.VerifiedAt.Time.UTC().Format(time.RFC3339)
	}
	out.IsPlatformAdmin = IsPlatformAdminEmail(u.Email)
	return out
}

// AuthTenant describes a tenant the user belongs to. Plan /
// SubscriptionStatus / WarehouseLimit / IsLocked are legacy fields from the
// hosted product; self-hosted Spatial Map always returns
// plan="self-hosted", subscriptionStatus="active", warehouseLimit=0
// (meaning "no limit"), isLocked=false, and omits trialEndsAt /
// subscribedAt. Build values with newAuthTenant.
type AuthTenant struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name"`
	Color              string `json:"color"`
	Role               string `json:"role"`
	Plan               string `json:"plan"`
	WarehouseLimit     int32  `json:"warehouseLimit"`
	TrialEndsAt        string `json:"trialEndsAt,omitempty"`
	SubscriptionStatus string `json:"subscriptionStatus"`
	SubscribedAt       string `json:"subscribedAt,omitempty"`
	IsLocked           bool   `json:"isLocked"`
	// Permissions decide what the UI offers (the API enforces the same,
	// api/permissions.go). CustomRoleID / RoleName are set for a custom role.
	Permissions  []string `json:"permissions"`
	CustomRoleID int64    `json:"customRoleId,omitempty"`
	RoleName     string   `json:"roleName,omitempty"`
}

// authTenantPermissions is a membership's permission list for the session.
func authTenantPermissions(role string, customRoleID pgtype.Int8, customPerms []string) []string {
	if customRoleID.Valid {
		return customPerms
	}
	return api.BuiltinPermissions(role)
}

// AuthResponse is returned by signup and login.
type AuthResponse struct {
	Token   string       `json:"token"`
	User    AuthUser     `json:"user"`
	Tenants []AuthTenant `json:"tenants"`
}

// AuthMember is the public representation of a tenant member, used in the
// "manage members" admin screen.
type AuthMember struct {
	UserID int64  `json:"userId"`
	Email  string `json:"email"`
	// Role is the built-in role, or for a custom role its base role
	// (editor / viewer); CustomRoleID + RoleName then name the custom role.
	Role         string `json:"role"`
	CustomRoleID int64  `json:"customRoleId,omitempty"`
	RoleName     string `json:"roleName,omitempty"`
	DisplayName  string `json:"displayName,omitempty"`
}

// ---- Router ----------------------------------------------------------------

// AuthRouter mounts authentication and self-service endpoints. Mounted
// outside TenantMiddleware because signup/login don't have a tenant yet.
//
// Rate limiting: each endpoint gets its own per-IP + per-email throttles
// (see auth.go's limiter block). IP limits are applied as middleware so
// they short-circuit before the body is decoded; email limits run inside
// the handler after decoding, since the email lives in the JSON body.
func AuthRouter(q *db.Queries, pool *pgxpool.Pool, jwtSecret string, m mailer.Mailer) chi.Router {
	r := chi.NewRouter()

	// Per-IP limiters (chi middleware). Burst allows a legitimate user to
	// mistype a code a few times without waiting; refill rate is what pins
	// down a scripted attacker over the long run. TTL is 1h so keys don't
	// accumulate forever from one-off visitors.
	//
	// signup-request is the most expensive (sends an email) and the biggest
	// abuse target (email-bomb), so it's the tightest.
	otpSendIP := api.NewKeyedLimiter(1.0/60.0, 3, time.Hour)   // 1/min, burst 3
	otpVerifyIP := api.NewKeyedLimiter(1.0/6.0, 10, time.Hour) // 10/min, burst 10
	loginIP := api.NewKeyedLimiter(1.0/6.0, 10, time.Hour)     // 10/min, burst 10

	// Per-email limiters (checked inside the handler). These stop an
	// attacker who rotates IPs from stacking attempts against one target
	// address. Deliberately tight — a single email getting hammered from
	// many IPs is almost certainly abuse.
	//
	// otpVerifyEmail is the load-bearing brute-force ceiling. 6-digit OTP
	// = 10^6 possibilities. Burst 5, refill 1/10min ≈ ~150 attempts/day →
	// ~18 years expected-case to crack a single code. Combined with the
	// 10-minute code TTL + 5-attempts-per-row limit, an attacker cannot
	// reasonably brute-force even a targeted email address.
	otpSendEmail := api.NewKeyedLimiter(1.0/900.0, 2, time.Hour)   // 1/15min, burst 2
	otpVerifyEmail := api.NewKeyedLimiter(1.0/600.0, 5, time.Hour) // 1/10min, burst 5
	loginEmail := api.NewKeyedLimiter(1.0/60.0, 5, time.Hour)      // 1/min, burst 5

	// Password reset gets its own buckets (same tuning as signup) so a
	// user who just signed up isn't starved when they immediately reset,
	// and vice versa. The complete step only needs an IP cap — it demands
	// a reset token, which the verify step's limits already protect.
	resetSendIP := api.NewKeyedLimiter(1.0/60.0, 3, time.Hour)
	resetSendEmail := api.NewKeyedLimiter(1.0/900.0, 2, time.Hour)
	resetVerifyIP := api.NewKeyedLimiter(1.0/6.0, 10, time.Hour)
	resetVerifyEmail := api.NewKeyedLimiter(1.0/600.0, 5, time.Hour)
	resetCompleteIP := api.NewKeyedLimiter(1.0/6.0, 10, time.Hour)

	tooManyMsg := "too many requests — please slow down and try again in a minute"

	r.With(api.RateLimitByIP(otpSendIP, tooManyMsg)).
		Post("/signup-request", authSignupRequest(q, m, otpSendEmail, tooManyMsg))
	r.With(api.RateLimitByIP(otpVerifyIP, tooManyMsg)).
		Post("/verify-otp", authVerifyOTP(q, jwtSecret, otpVerifyEmail, tooManyMsg))
	// New accounts per IP per day (counted when an account is created, so
	// typos and weak-password retries don't use it up). In memory: a restart
	// resets it. Only with the sign-up guard on (signup_guard.go).
	signupDailyIP := api.NewKeyedLimiter(3.0/86400.0, 3, 25*time.Hour)
	r.Post("/complete-signup", authCompleteSignup(q, pool, jwtSecret, signupDailyIP))
	r.With(api.RateLimitByIP(loginIP, tooManyMsg)).
		Post("/login", authLogin(q, jwtSecret, loginEmail, tooManyMsg))
	r.With(api.RateLimitByIP(resetSendIP, tooManyMsg)).
		Post("/password-reset-request", authPasswordResetRequest(q, m, resetSendEmail, tooManyMsg))
	r.With(api.RateLimitByIP(resetVerifyIP, tooManyMsg)).
		Post("/password-reset-verify", authPasswordResetVerify(q, jwtSecret, resetVerifyEmail, tooManyMsg))
	r.With(api.RateLimitByIP(resetCompleteIP, tooManyMsg)).
		Post("/password-reset-complete", authPasswordResetComplete(q, jwtSecret, m))
	r.Post("/logout", authLogout())
	r.Get("/me", authMe(q))
	return r
}

// TenantMembersRouter mounts membership management for the current tenant.
// Tenant-scoped (requires X-Tenant-Id) and JWT-protected.
func TenantMembersRouter(q *db.Queries, pool *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Get("/", listTenantMembers(q))
	r.Post("/", inviteTenantMember(q, pool))
	r.Patch("/{userId}", updateTenantMemberRole(q))
	r.Delete("/{userId}", removeTenantMember(q))
	return r
}

// ---- Signup step 1: email → OTP --------------------------------------------

func authSignupRequest(q *db.Queries, m mailer.Mailer, emailLimiter *api.KeyedLimiter, tooManyMsg string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req SignupRequestBody
		if err := api.DecodeBody(r, &req); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		if !emailRegex.MatchString(email) {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidEmail, "invalid email")
			return
		}
		if signupGuard && isDisposableEmail(email) {
			api.ErrorCode(w, http.StatusBadRequest, codeEmailDisposable, "please sign up with a permanent email address")
			return
		}
		// Per-email throttle: stops an attacker who rotates IPs from
		// email-bombing one victim's inbox with sign-up codes.
		if ok, wait := emailLimiter.Check(email); !ok {
			api.TooManyRequests(w, wait, tooManyMsg)
			return
		}

		// Uniform response regardless of whether an account already exists —
		// closes the user-enumeration side-channel that a 409 would open.
		// Below, we branch on existence to decide what (if anything) to
		// email, but the HTTP response is identical either way.
		alreadyRegistered := false
		if _, err := q.GetUserByEmail(r.Context(), email); err == nil {
			alreadyRegistered = true
		} else if !errors.Is(err, pgx.ErrNoRows) {
			api.InternalError(w, r, err)
			return
		}
		// Sign-up guard: another spelling of a Gmail inbox that already has
		// an account (dots, +alias) counts as the same account.
		if id := gmailIdentity(email); signupGuard && !alreadyRegistered && id != "" {
			taken, err := q.GmailInboxHasUser(r.Context(), id)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			alreadyRegistered = taken
		}

		if !alreadyRegistered {
			// Rotate any prior OTP for this address so we never leave two
			// live codes floating around.
			if err := q.InvalidateOTPCodesForEmail(r.Context(), db.InvalidateOTPCodesForEmailParams{
				Email:   email,
				Purpose: otpPurposeSignup,
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}

			code, err := mailer.GenerateOTPCode()
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			codeHash, err := auth.HashPassword(code)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			if _, err := q.CreateOTPCode(r.Context(), db.CreateOTPCodeParams{
				Email:     email,
				CodeHash:  codeHash,
				Purpose:   otpPurposeSignup,
				ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(otpLifetime), Valid: true},
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}
			// Deliver in a background goroutine so a slow SMTP server
			// doesn't stall the request.
			go func(recipient, code string) {
				deliverCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				if err := mailer.SendOTP(deliverCtx, m, recipient, code); err != nil {
					slog.Error("send otp failed", "email", recipient, "error", err)
				}
			}(email, code)
		} else {
			// Existing account: don't create an OTP row (the whole point
			// is that the caller learns nothing). Send a courtesy notice
			// to the real user's inbox so they know someone poked their
			// email address and can log in if it was them.
			slog.Info("signup-request suppressed for existing account", "email", email)
			// Spend the bcrypt cost the new-account branch spends hashing
			// the code, so latency can't tell the two branches apart.
			auth.DummyVerify(email)
			go func(recipient string) {
				deliverCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				if err := mailer.SendAlreadyRegistered(deliverCtx, m, recipient); err != nil {
					slog.Error("send already-registered notice failed", "email", recipient, "error", err)
				}
			}(email)
		}

		api.JSON(w, http.StatusOK, map[string]any{
			"ok":        true,
			"email":     email,
			"expiresIn": int(otpLifetime.Seconds()),
		})
	}
}

// ---- Signup step 2: OTP → verification token -------------------------------

func authVerifyOTP(q *db.Queries, jwtSecret string, emailLimiter *api.KeyedLimiter, tooManyMsg string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req VerifyOTPBody
		if err := api.DecodeBody(r, &req); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		code := strings.TrimSpace(req.Code)
		if email == "" || code == "" {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "email and code are required")
			return
		}
		// Per-email throttle closes the row-rotation brute-force loophole:
		// the 5-attempts-per-OTP-row cap is meaningless if an attacker can
		// request a fresh row and reset the counter, so we cap total verify
		// attempts per email address here.
		if ok, wait := emailLimiter.Check(email); !ok {
			api.TooManyRequests(w, wait, tooManyMsg)
			return
		}

		if !checkOTP(w, r, q, email, code, otpPurposeSignup) {
			return
		}

		// Mint a short-lived verification token. UserID is 0 (no user yet)
		// and Email carries the verified address. The scope prefix defends
		// against a caller reusing the token as a login JWT.
		vToken, err := auth.IssueVerificationToken(jwtSecret, email, verificationTokenScope, verificationTokenLifetime)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, VerifyOTPResponse{
			VerificationToken: vToken,
			Email:             email,
			ExpiresAt:         time.Now().Add(verificationTokenLifetime).UTC().Format(time.RFC3339),
		})
	}
}

// ---- Signup step 3: verification token + password → session ----------------

func authCompleteSignup(q *db.Queries, pool *pgxpool.Pool, jwtSecret string, dailyIP *api.KeyedLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req CompleteSignupBody
		if err := api.DecodeBody(r, &req); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		if !emailRegex.MatchString(email) {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidEmail, "invalid email")
			return
		}
		if err := auth.ValidatePassword(req.Password); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codePasswordWeak, err.Error())
			return
		}

		// Verify the token proves the email address. The scope prefix stops
		// anyone from replaying a login JWT here.
		verifiedEmail, err := auth.ParseVerificationToken(jwtSecret, req.VerificationToken, verificationTokenScope)
		if err != nil || verifiedEmail == "" || verifiedEmail != email {
			api.ErrorCode(w, http.StatusUnauthorized, codeVerificationExpired, "verification token invalid or expired — please verify your email again")
			return
		}

		// A racing signup could have created the row between /verify-otp and
		// here. Fail cleanly.
		if _, err := q.GetUserByEmail(r.Context(), email); err == nil {
			api.ErrorCode(w, http.StatusConflict, codeEmailTaken, "an account with this email already exists")
			return
		} else if !errors.Is(err, pgx.ErrNoRows) {
			api.InternalError(w, r, err)
			return
		}
		if signupGuard {
			// Another spelling of the same Gmail inbox, and throwaway inboxes
			// (signup-request refuses them too; this covers a token minted
			// before the guard was turned on).
			if id := gmailIdentity(email); id != "" {
				taken, err := q.GmailInboxHasUser(r.Context(), id)
				if err != nil {
					api.InternalError(w, r, err)
					return
				}
				if taken {
					api.ErrorCode(w, http.StatusConflict, codeEmailTaken, "an account with this email already exists")
					return
				}
			}
			if isDisposableEmail(email) {
				api.ErrorCode(w, http.StatusBadRequest, codeEmailDisposable, "please sign up with a permanent email address")
				return
			}
			// Daily new-account cap per IP, spent only now that an account
			// is about to be created.
			if ok, wait := dailyIP.Check(api.ClientIP(r)); !ok {
				api.TooManyRequests(w, wait, "too many new accounts from this network today — please try again tomorrow")
				return
			}
		}

		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(r.Context())
		qtx := q.WithTx(tx)

		user, err := qtx.CreateUser(r.Context(), db.CreateUserParams{
			Email:        email,
			PasswordHash: hash,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		// The user completed OTP verification — stamp them as verified
		// immediately so the /me response reflects it.
		if err := qtx.MarkUserVerified(r.Context(), user.ID); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// Tenant name comes from displayName when supplied, else the email's
		// local-part with " workspace" suffix.
		localPart := email
		if at := strings.Index(localPart, "@"); at > 0 {
			localPart = localPart[:at]
		}
		tenantName := localPart + "'s workspace"
		if dn := strings.TrimSpace(req.DisplayName); dn != "" {
			tenantName = dn + "'s workspace"
		}

		tenant, err := qtx.CreateTenant(r.Context(), db.CreateTenantParams{
			Name:  tenantName,
			Color: "#3b82f6",
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		if _, err := qtx.AddUserTenant(r.Context(), db.AddUserTenantParams{
			UserID:   user.ID,
			TenantID: tenant.ID,
			Role:     RoleOwner,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		tenants := []AuthTenant{newAuthTenant(tenant.ID, tenant.Name, tenant.Color, RoleOwner)}

		// Every account joins the demo workspace (internal/demo) as an
		// editor with view access to its reports, listed first so a new
		// user lands among the sample facilities rather than in an empty
		// workspace.
		if demo, err := qtx.GetDemoTenant(r.Context()); err == nil {
			if _, err := qtx.AddUserTenant(r.Context(), db.AddUserTenantParams{
				UserID:   user.ID,
				TenantID: demo.ID,
				Role:     RoleEditor,
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}
			if err := qtx.GrantTenantReportsToUser(r.Context(), db.GrantTenantReportsToUserParams{
				TenantID: demo.ID,
				UserID:   user.ID,
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}
			tenants = append([]AuthTenant{newAuthTenant(demo.ID, demo.Name, demo.Color, RoleEditor)}, tenants...)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			api.InternalError(w, r, err)
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			api.InternalError(w, r, err)
			return
		}

		// Re-fetch the user so VerifiedAt is populated in the response.
		fresh, err := q.GetUserByID(r.Context(), user.ID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		token, err := auth.IssueToken(jwtSecret, user.ID, user.Email, auth.DefaultTokenLifetime)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		_ = q.UpdateUserLastLogin(r.Context(), user.ID)

		api.JSON(w, http.StatusCreated, AuthResponse{
			Token:   token,
			User:    toAuthUser(fresh),
			Tenants: tenants,
		})
	}
}

// ---- Shared: OTP check -------------------------------------------------------

// checkOTP validates `code` against the newest live OTP for (email, purpose)
// and consumes it on success. On failure it has already written the error
// response and returns false. Callers must run their per-email limiter
// first — the 5-attempts-per-row cap alone is defeated by requesting a
// fresh row.
func checkOTP(w http.ResponseWriter, r *http.Request, q *db.Queries, email, code, purpose string) bool {
	row, err := q.GetLatestActiveOTP(r.Context(), db.GetLatestActiveOTPParams{
		Email:   email,
		Purpose: purpose,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			api.ErrorCode(w, http.StatusBadRequest, codeOTPExpired, "code expired or not found — please request a new one")
			return false
		}
		api.InternalError(w, r, err)
		return false
	}
	if row.Attempts >= otpMaxAttempts {
		// Burn the row so a fresh request has to be issued.
		_ = q.MarkOTPUsed(r.Context(), row.ID)
		api.ErrorCode(w, http.StatusTooManyRequests, codeOTPLocked, "too many attempts — request a new code")
		return false
	}
	if !auth.VerifyPassword(row.CodeHash, code) {
		_ = q.IncrementOTPAttempts(r.Context(), row.ID)
		api.ErrorCode(w, http.StatusBadRequest, codeOTPIncorrect, "incorrect code")
		return false
	}
	// Mark the OTP consumed. Even if the user later abandons the flow,
	// they'll have to request a fresh code — safer than leaving a used
	// code live for the whole 10-minute window.
	if err := q.MarkOTPUsed(r.Context(), row.ID); err != nil {
		api.InternalError(w, r, err)
		return false
	}
	return true
}

// ---- Password reset: email → OTP → new password ----------------------------
//
// Mirrors the signup flow and follows the OWASP Forgot Password cheat
// sheet: the request step answers identically (status, body and timing)
// whether or not the account exists, codes are single-use and expire in
// otpLifetime, the reset token is single-use, completing the reset signs
// out every session (users.password_changed_at, see api/session_revocation.go)
// and emails a confirmation, and the user is NOT signed in automatically.

func authPasswordResetRequest(q *db.Queries, m mailer.Mailer, emailLimiter *api.KeyedLimiter, tooManyMsg string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req PasswordResetRequestBody
		if err := api.DecodeBody(r, &req); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		if !emailRegex.MatchString(email) {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidEmail, "invalid email")
			return
		}
		if ok, wait := emailLimiter.Check(email); !ok {
			api.TooManyRequests(w, wait, tooManyMsg)
			return
		}

		_, err := q.GetUserByEmail(r.Context(), email)
		switch {
		case err == nil:
			if err := q.InvalidateOTPCodesForEmail(r.Context(), db.InvalidateOTPCodesForEmailParams{
				Email:   email,
				Purpose: otpPurposeReset,
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}
			code, err := mailer.GenerateOTPCode()
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			codeHash, err := auth.HashPassword(code)
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			if _, err := q.CreateOTPCode(r.Context(), db.CreateOTPCodeParams{
				Email:     email,
				CodeHash:  codeHash,
				Purpose:   otpPurposeReset,
				ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(otpLifetime), Valid: true},
			}); err != nil {
				api.InternalError(w, r, err)
				return
			}
			go func(recipient, code string) {
				deliverCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				if err := mailer.SendPasswordResetOTP(deliverCtx, m, recipient, code); err != nil {
					slog.Error("send password reset otp failed", "email", recipient, "error", err)
				}
			}(email, code)
		case errors.Is(err, pgx.ErrNoRows):
			// Unknown address: send nothing (we'd be emailing a stranger),
			// but spend the same bcrypt cost as the branch above so the
			// response time doesn't reveal that the account is missing.
			auth.DummyVerify(email)
		default:
			api.InternalError(w, r, err)
			return
		}

		api.JSON(w, http.StatusOK, map[string]any{
			"ok":        true,
			"email":     email,
			"expiresIn": int(otpLifetime.Seconds()),
		})
	}
}

func authPasswordResetVerify(q *db.Queries, jwtSecret string, emailLimiter *api.KeyedLimiter, tooManyMsg string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req VerifyOTPBody
		if err := api.DecodeBody(r, &req); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		code := strings.TrimSpace(req.Code)
		if email == "" || code == "" {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "email and code are required")
			return
		}
		if ok, wait := emailLimiter.Check(email); !ok {
			api.TooManyRequests(w, wait, tooManyMsg)
			return
		}
		// An unregistered address never gets a reset OTP row, so it lands
		// on checkOTP's "expired or not found" branch — the same answer a
		// registered address with a stale code gets.
		if !checkOTP(w, r, q, email, code, otpPurposeReset) {
			return
		}
		token, err := auth.IssueVerificationToken(jwtSecret, email, resetTokenScope, verificationTokenLifetime)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, PasswordResetVerifyResponse{
			ResetToken: token,
			Email:      email,
			ExpiresAt:  time.Now().Add(verificationTokenLifetime).UTC().Format(time.RFC3339),
		})
	}
}

func authPasswordResetComplete(q *db.Queries, jwtSecret string, m mailer.Mailer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req PasswordResetCompleteBody
		if err := api.DecodeBody(r, &req); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
			return
		}
		email := strings.TrimSpace(strings.ToLower(req.Email))
		const expiredMsg = "reset token invalid or expired — please request a new code"

		// Token first: an expired flow should send the user back to the
		// start, not make them fix a password they'll have to retype.
		tokenEmail, issuedAt, err := auth.ParseVerificationTokenIssued(jwtSecret, req.ResetToken, resetTokenScope)
		if err != nil || tokenEmail == "" || tokenEmail != email {
			api.ErrorCode(w, http.StatusUnauthorized, codeVerificationExpired, expiredMsg)
			return
		}
		if err := auth.ValidatePassword(req.Password); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codePasswordWeak, err.Error())
			return
		}
		user, err := q.GetUserByEmail(r.Context(), email)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.ErrorCode(w, http.StatusUnauthorized, codeVerificationExpired, expiredMsg)
				return
			}
			api.InternalError(w, r, err)
			return
		}
		// Single use: once the password has changed at or after the token
		// was minted, the token is spent.
		if user.PasswordChangedAt.Valid && user.PasswordChangedAt.Time.Unix() >= issuedAt.Unix() {
			api.ErrorCode(w, http.StatusUnauthorized, codeVerificationExpired, expiredMsg)
			return
		}

		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		changedAt, err := q.UpdateUserPassword(r.Context(), db.UpdateUserPasswordParams{
			ID:           user.ID,
			PasswordHash: hash,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		// Every token minted before now is dead from this request on.
		api.NoteSessionRevocation(user.ID, changedAt.Time)
		// Receiving the code proved control of the address.
		_ = q.MarkUserVerified(r.Context(), user.ID)
		_ = q.InvalidateOTPCodesForEmail(r.Context(), db.InvalidateOTPCodesForEmailParams{
			Email:   email,
			Purpose: otpPurposeReset,
		})

		go func(recipient string, at time.Time) {
			deliverCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := mailer.SendPasswordChanged(deliverCtx, m, recipient, at); err != nil {
				slog.Error("send password changed notice failed", "email", recipient, "error", err)
			}
		}(email, changedAt.Time)

		api.JSON(w, http.StatusOK, map[string]any{"ok": true, "email": email})
	}
}

// ---- Login -----------------------------------------------------------------

func authLogin(q *db.Queries, jwtSecret string, emailLimiter *api.KeyedLimiter, tooManyMsg string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req AuthLoginRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
			return
		}
		req.Email = strings.TrimSpace(strings.ToLower(req.Email))
		// Per-email throttle for password brute-force. Runs BEFORE the DB
		// lookup so a scripted attacker learns nothing from timing (the
		// 429 shape is the same whether or not the email exists).
		if ok, wait := emailLimiter.Check(req.Email); !ok {
			api.TooManyRequests(w, wait, tooManyMsg)
			return
		}
		const generic = "invalid email or password"

		user, err := q.GetUserByEmail(r.Context(), req.Email)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// Timing-safe: burn the same bcrypt work we would have
				// on a real user so response time doesn't reveal whether
				// the email is registered. Without this, an attacker can
				// enumerate valid accounts by measuring latency (real
				// bcrypt = 60-80 ms, missing user = <1 ms).
				auth.DummyVerify(req.Password)
				api.ErrorCode(w, http.StatusUnauthorized, codeInvalidCredentials, generic)
				return
			}
			api.InternalError(w, r, err)
			return
		}
		if !auth.VerifyPassword(user.PasswordHash, req.Password) {
			api.ErrorCode(w, http.StatusUnauthorized, codeInvalidCredentials, generic)
			return
		}

		memberships, err := q.ListUserTenants(r.Context(), user.ID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		tenants := toAuthTenants(memberships)

		token, err := auth.IssueToken(jwtSecret, user.ID, user.Email, auth.DefaultTokenLifetime)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		_ = q.UpdateUserLastLogin(r.Context(), user.ID)

		api.JSON(w, http.StatusOK, AuthResponse{
			Token:   token,
			User:    toAuthUser(user),
			Tenants: tenants,
		})
	}
}

// authLogout is mostly client-driven (the client discards the token). We
// return 204 to confirm. Real revocation would require a token blocklist —
// out of scope for this auth model.
func authLogout() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		api.JSON(w, http.StatusNoContent, nil)
	}
}

func authMe(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := api.UserID(r.Context())
		if userID == 0 {
			api.ErrorCode(w, http.StatusUnauthorized, codeNotAuthenticated, "not authenticated")
			return
		}
		user, err := q.GetUserByID(r.Context(), userID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.ErrorCode(w, http.StatusUnauthorized, codeNotAuthenticated, "user no longer exists")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		memberships, err := q.ListUserTenants(r.Context(), user.ID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, AuthResponse{
			Token:   "",
			User:    toAuthUser(user),
			Tenants: toAuthTenants(memberships),
		})
	}
}

// ---- Tenant projection -----------------------------------------------------

// newAuthTenant builds an AuthTenant with the neutral self-hosted plan
// projection (see AuthTenant).
func newAuthTenant(id int64, name, color, role string) AuthTenant {
	return AuthTenant{
		ID:                 id,
		Name:               name,
		Color:              color,
		Role:               role,
		Plan:               SelfHostedPlan,
		WarehouseLimit:     0,
		SubscriptionStatus: SelfHostedSubscriptionStatus,
		IsLocked:           false,
		Permissions:        api.BuiltinPermissions(role),
	}
}

func timestampToRFC3339(t pgtype.Timestamptz) string {
	if !t.Valid {
		return ""
	}
	return t.Time.UTC().Format(time.RFC3339)
}

func toAuthTenants(rows []db.ListUserTenantsRow) []AuthTenant {
	out := make([]AuthTenant, len(rows))
	for i, row := range rows {
		out[i] = newAuthTenant(row.TenantID, row.TenantName, row.TenantColor, row.Role)
		out[i].Permissions = authTenantPermissions(row.Role, row.CustomRoleID, row.CustomPermissions)
		out[i].CustomRoleID = row.CustomRoleID.Int64
		out[i].RoleName = row.CustomRoleName
	}
	return out
}

// ---- Members ---------------------------------------------------------------

// listTenantMembers returns the roster for the current tenant. Any member
// can list; only owners/admins can mutate (enforced in mutation handlers).
func listTenantMembers(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID := api.TenantID(r.Context())
		rows, err := q.ListTenantMembersWithRoles(r.Context(), tenantID)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		out := make([]AuthMember, len(rows))
		for i, row := range rows {
			out[i] = AuthMember{UserID: row.UserID, Email: row.Email, Role: row.Role,
				CustomRoleID: row.CustomRoleID.Int64, RoleName: row.CustomRoleName, DisplayName: row.DisplayName}
		}
		api.JSON(w, http.StatusOK, out)
	}
}

// InviteMemberRequest is the body for adding a user to a tenant. With only
// an email the invitee must already have an account. With a password too,
// an owner/admin creates the account when the email has none (a workspace
// without public sign-up can still add its people); an existing account is
// added as it is and keeps its own password.
type InviteMemberRequest struct {
	Email    string `json:"email"`
	Role     string `json:"role"`
	Name     string `json:"name,omitempty"`
	Password string `json:"password,omitempty"`
	// RoleID picks a custom role instead of Role.
	RoleID int64 `json:"roleId,omitempty"`
}

// InviteMemberResponse says whether the account was created by the call.
type InviteMemberResponse struct {
	AuthMember
	Created bool `json:"created"`
}

func inviteTenantMember(q *db.Queries, pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermMembersManage) {
			return
		}
		var req InviteMemberRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
			return
		}
		req.Email = strings.TrimSpace(strings.ToLower(req.Email))
		if !emailRegex.MatchString(req.Email) {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidEmail, "invalid email")
			return
		}
		// Owner can only be assigned by the tenant creator at signup; nobody
		// gives a role with permissions they don't hold themselves.
		choice, ok := resolveRoleChoice(w, r, q, req.Role, req.RoleID)
		if !ok {
			return
		}

		ctx := r.Context()
		tenantID := api.TenantID(ctx)
		invitee, err := q.GetUserByEmail(ctx, req.Email)
		exists := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			api.InternalError(w, r, err)
			return
		}
		if !exists && req.Password == "" {
			api.NotFound(w, "no user with that email — they must sign up first")
			return
		}
		hash := ""
		if !exists {
			if err := auth.ValidatePassword(req.Password); err != nil {
				api.ErrorCode(w, http.StatusBadRequest, codePasswordWeak, err.Error())
				return
			}
			if hash, err = auth.HashPassword(req.Password); err != nil {
				api.InternalError(w, r, err)
				return
			}
		}

		tx, err := pool.Begin(ctx)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		defer tx.Rollback(ctx)
		qtx := q.WithTx(tx)
		if !exists {
			u, err := qtx.CreateUser(ctx, db.CreateUserParams{Email: req.Email, PasswordHash: hash})
			if err != nil {
				api.InternalError(w, r, err)
				return
			}
			// Created by a workspace admin, who vouches for the address.
			if err := qtx.MarkUserVerified(ctx, u.ID); err != nil {
				api.InternalError(w, r, err)
				return
			}
			if name := strings.TrimSpace(req.Name); name != "" {
				if u, err = qtx.UpdateUserProfile(ctx, db.UpdateUserProfileParams{ID: u.ID, DisplayName: name}); err != nil {
					api.InternalError(w, r, err)
					return
				}
			}
			invitee = u
		}
		if _, err := qtx.AddUserTenant(ctx, db.AddUserTenantParams{
			UserID:   invitee.ID,
			TenantID: tenantID,
			Role:     choice.Base,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := qtx.SetMemberRole(ctx, db.SetMemberRoleParams{Role: choice.Base, CustomRoleID: choice.CustomID, UserID: invitee.ID, TenantID: tenantID}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, InviteMemberResponse{
			AuthMember: AuthMember{UserID: invitee.ID, Email: invitee.Email, Role: choice.Base,
				CustomRoleID: choice.CustomID.Int64, RoleName: choice.CustomName, DisplayName: invitee.DisplayName},
			Created: !exists,
		})
	}
}

// UpdateMemberRequest is the body for changing a member's role: a built-in
// Role, or a custom role by RoleID.
type UpdateMemberRequest struct {
	Role   string `json:"role"`
	RoleID int64  `json:"roleId,omitempty"`
}

func updateTenantMemberRole(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermMembersManage) {
			return
		}
		targetUserID, err := api.IDParam(r, "userId")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		var req UpdateMemberRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.ErrorCode(w, http.StatusBadRequest, codeInvalidRequest, "invalid request body")
			return
		}
		tenantID := api.TenantID(r.Context())
		// Don't let admins downgrade an owner — only an owner can demote
		// themselves, and that's left to a future "transfer ownership" flow.
		// Nobody changes someone who can do more than they can.
		existingRole, existingPerms, err := memberPermissions(r, q, targetUserID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "member not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		if existingRole == RoleOwner {
			api.Error(w, http.StatusForbidden, "cannot change the owner's role")
			return
		}
		if !api.HasAllPermissions(r.Context(), existingPerms) {
			api.ErrorCode(w, http.StatusForbidden, codeRoleEscalates, "you can't change someone who can do more than you")
			return
		}
		choice, ok := resolveRoleChoice(w, r, q, req.Role, req.RoleID)
		if !ok {
			return
		}
		if err := q.SetMemberRole(r.Context(), db.SetMemberRoleParams{
			Role: choice.Base, CustomRoleID: choice.CustomID, UserID: targetUserID, TenantID: tenantID,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, AuthMember{UserID: targetUserID, Role: choice.Base, CustomRoleID: choice.CustomID.Int64, RoleName: choice.CustomName})
	}
}

func removeTenantMember(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !api.RequirePermission(w, r, api.PermMembersManage) {
			return
		}
		targetUserID, err := api.IDParam(r, "userId")
		if err != nil {
			api.BadRequest(w, err.Error())
			return
		}
		tenantID := api.TenantID(r.Context())
		existingRole, existingPerms, err := memberPermissions(r, q, targetUserID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.NotFound(w, "member not found")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		if existingRole == RoleOwner {
			api.Error(w, http.StatusForbidden, "cannot remove the owner")
			return
		}
		if !api.HasAllPermissions(r.Context(), existingPerms) {
			api.ErrorCode(w, http.StatusForbidden, codeRoleEscalates, "you can't remove someone who can do more than you")
			return
		}
		if err := q.RemoveUserTenant(r.Context(), db.RemoveUserTenantParams{
			UserID:   targetUserID,
			TenantID: tenantID,
		}); err != nil {
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusNoContent, nil)
	}
}

// requireRole writes a 403 and returns false if the caller's role on the
// current tenant is not one of the allowed roles.
func requireRole(w http.ResponseWriter, r *http.Request, q *db.Queries, allowed ...string) bool {
	userID := api.UserID(r.Context())
	tenantID := api.TenantID(r.Context())
	if userID == 0 || tenantID == 0 {
		api.Error(w, http.StatusUnauthorized, "not authenticated")
		return false
	}
	m, err := q.GetUserTenantMembership(r.Context(), db.GetUserTenantMembershipParams{
		UserID:   userID,
		TenantID: tenantID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			api.Error(w, http.StatusForbidden, "not a member of this tenant")
			return false
		}
		api.InternalError(w, r, err)
		return false
	}
	for _, role := range allowed {
		if m.Role == role {
			return true
		}
	}
	api.Error(w, http.StatusForbidden, "insufficient permissions")
	return false
}

func isValidRole(role string) bool {
	switch role {
	case RoleOwner, RoleAdmin, RoleEditor, RoleViewer:
		return true
	}
	return false
}
