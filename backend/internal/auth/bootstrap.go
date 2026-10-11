package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5"
)

// Bootstrap creates an initial admin user with the given credentials if one
// does not already exist, and links them as owner of every existing tenant
// (including the demo workspace, see internal/demo).
//
// Idempotent: if the user already exists, the function is a no-op (password
// is NOT rotated — to reset a password use cmd/seed-admin explicitly).
// Returns nil with no work done when email or password is empty.
func Bootstrap(ctx context.Context, q *db.Queries, email, password string) error {
	if email == "" || password == "" {
		return nil
	}

	if _, err := q.GetUserByEmail(ctx, email); err == nil {
		slog.Info("bootstrap: user already exists, skipping", "email", email)
		return nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("lookup user: %w", err)
	}

	hash, err := HashPassword(password)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}

	user, err := q.CreateUser(ctx, db.CreateUserParams{
		Email:        email,
		PasswordHash: hash,
	})
	if err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	slog.Info("bootstrap: created admin user", "email", email, "user_id", user.ID)

	tenants, err := q.ListTenants(ctx)
	if err != nil {
		return fmt.Errorf("list tenants: %w", err)
	}

	tenantIDs := make([]int64, 0, len(tenants)+1)
	for _, t := range tenants {
		tenantIDs = append(tenantIDs, t.ID)
	}

	// No workspace of their own yet (none at all, or only the demo
	// workspace)? Create one so the admin has a workspace to build in.
	onlyDemo := false
	if len(tenantIDs) == 1 {
		if d, err := q.GetDemoTenant(ctx); err == nil && d.ID == tenantIDs[0] {
			onlyDemo = true
		} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lookup demo workspace: %w", err)
		}
	}
	if len(tenantIDs) == 0 || onlyDemo {
		t, err := q.CreateTenant(ctx, db.CreateTenantParams{
			Name:  "Admin workspace",
			Color: "#3b82f6",
		})
		if err != nil {
			return fmt.Errorf("create default tenant: %w", err)
		}
		tenantIDs = append(tenantIDs, t.ID)
		slog.Info("bootstrap: created default tenant", "tenant_id", t.ID)
	}

	for _, tenantID := range tenantIDs {
		if _, err := q.AddUserTenant(ctx, db.AddUserTenantParams{
			UserID:   user.ID,
			TenantID: tenantID,
			Role:     "owner",
		}); err != nil {
			return fmt.Errorf("link tenant %d: %w", tenantID, err)
		}
	}

	// Stamp the user as verified — they authenticated by env-var, not OTP,
	// so the "verified" gate that new users pass should be granted here too.
	if err := q.MarkUserVerified(ctx, user.ID); err != nil {
		return fmt.Errorf("mark verified: %w", err)
	}

	slog.Info("bootstrap: linked admin to existing tenants", "count", len(tenantIDs))
	return nil
}
