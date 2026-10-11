package mailer

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"html"
	"net/url"
	"strings"
	"time"
)

// GenerateOTPCode returns a cryptographically-random 6-digit numeric code
// as a string (with leading zeroes preserved). Not a JWT — the OTP is only
// used to prove the user controls the email address, then discarded.
func GenerateOTPCode() (string, error) {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	n := binary.BigEndian.Uint32(buf[:]) % 1000000
	return fmt.Sprintf("%06d", n), nil
}

// productName is how every auth email refers to the product. Matches the
// SPA's <title> and the default `mail.from_name`.
const productName = "Spatial Map"

// DefaultAppURL is the SPA origin used for email links when
// `app.public_url` (SGV_APP.PUBLIC_URL) is not configured — the Vite dev
// server. Self-hosters must set the real public URL in production.
const DefaultAppURL = "http://localhost:5173"

// appURL is the absolute origin of the SPA, used for sign-in / reset links.
// Set once at boot from `app.public_url` (SGV_APP.PUBLIC_URL).
var appURL = DefaultAppURL

// SetAppURL overrides the origin used in email links. Empty is ignored so
// an unset config value can't produce relative (broken) links.
func SetAppURL(u string) {
	if u = strings.TrimRight(strings.TrimSpace(u), "/"); u != "" {
		appURL = u
	}
}

// emailContent is one transactional email in the shared layout. Every
// field is plain text; renderEmail escapes it.
type emailContent struct {
	Heading   string
	Intro     string
	Code      string // optional: rendered as a large monospace block
	CTALabel  string // optional: rendered as a button to CTAURL
	CTAURL    string
	Footnote  string
	PlainTail string // extra plain-text lines appended after the intro
}

func renderEmail(c emailContent) (text, htmlBody string) {
	var t strings.Builder
	t.WriteString(c.Heading + "\n\n" + c.Intro + "\n")
	if c.Code != "" {
		t.WriteString("\n    " + c.Code + "\n")
	}
	if c.PlainTail != "" {
		t.WriteString("\n" + c.PlainTail + "\n")
	}
	if c.CTAURL != "" {
		t.WriteString("\n" + c.CTALabel + ": " + c.CTAURL + "\n")
	}
	t.WriteString("\n" + c.Footnote + "\n\n— " + productName + "\n")

	esc := html.EscapeString
	var h strings.Builder
	h.WriteString(`<!doctype html>
<html><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f4f4f5;margin:0;padding:32px 16px">
  <div style="max-width:480px;margin:0 auto">
    <div style="padding:0 0 16px;text-align:center">
      <a href="` + esc(appURL) + `" style="font-size:16px;font-weight:600;color:#18181b;text-decoration:none">` + productName + `</a>
    </div>
    <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e4e4e7">
      <h2 style="margin:0 0 12px;color:#18181b;font-size:20px">` + esc(c.Heading) + `</h2>
      <p style="color:#52525b;margin:0 0 24px;line-height:1.5">` + esc(c.Intro) + `</p>`)
	if c.Code != "" {
		h.WriteString(`
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:32px;letter-spacing:8px;font-weight:700;color:#18181b;background:#f4f4f5;border-radius:8px;padding:16px;text-align:center">` + esc(c.Code) + `</div>`)
	}
	if c.PlainTail != "" {
		h.WriteString(`
      <p style="color:#52525b;margin:24px 0 0;line-height:1.5">` + esc(c.PlainTail) + `</p>`)
	}
	if c.CTAURL != "" {
		h.WriteString(`
      <p style="margin:24px 0 0"><a href="` + esc(c.CTAURL) + `" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">` + esc(c.CTALabel) + `</a></p>`)
	}
	h.WriteString(`
      <p style="color:#71717a;margin:24px 0 0;font-size:13px;line-height:1.5">` + esc(c.Footnote) + `</p>
    </div>
    <p style="color:#a1a1aa;font-size:12px;text-align:center;margin:16px 0 0">` + productName + ` · <a href="` + esc(appURL) + `" style="color:#a1a1aa">` + esc(appURL) + `</a></p>
  </div>
</body></html>
`)
	return t.String(), h.String()
}

func send(ctx context.Context, m Mailer, to, subject string, c emailContent) error {
	text, htmlBody := renderEmail(c)
	return m.Send(ctx, Message{To: to, Subject: subject, TextBody: text, HTMLBody: htmlBody})
}

// SendAlreadyRegistered notifies an existing user that someone tried to
// sign up with their email. Sent instead of an OTP so the account-exists
// signal reaches the legitimate user (via their inbox) without leaking
// existence to the caller (via the HTTP response).
func SendAlreadyRegistered(ctx context.Context, m Mailer, to string) error {
	return send(ctx, m, to, "You already have a "+productName+" account", emailContent{
		Heading:   "You already have an account",
		Intro:     "Someone just tried to sign up for " + productName + " using this email address. You already have an account with us, so no new account was created.",
		PlainTail: "If this was you, sign in with your existing password. Forgot it? You can reset it from the sign-in page.",
		CTALabel:  "Sign in",
		CTAURL:    appURL + "/login?email=" + url.QueryEscape(to),
		Footnote:  "If it wasn't you, no action is needed — no one can access your account without your password.",
	})
}

// SendOTP composes and delivers the signup verification email.
func SendOTP(ctx context.Context, m Mailer, to, code string) error {
	return send(ctx, m, to, "Your "+productName+" verification code: "+code, emailContent{
		Heading:  "Verify your email",
		Intro:    "Enter this code in " + productName + " to finish creating your account.",
		Code:     code,
		Footnote: "This code expires in 10 minutes. If you didn't request it, you can safely ignore this email.",
	})
}

// SendPasswordResetOTP delivers the code for the forgot-password flow.
// Only ever sent to a registered address — the endpoint answers the same
// either way, so the email is the only place existence is revealed, and
// it reaches the account owner alone.
func SendPasswordResetOTP(ctx context.Context, m Mailer, to, code string) error {
	return send(ctx, m, to, "Your "+productName+" password reset code: "+code, emailContent{
		Heading:  "Reset your password",
		Intro:    "Enter this code in " + productName + " to choose a new password.",
		Code:     code,
		Footnote: "This code expires in 10 minutes. If you didn't ask to reset your password, ignore this email — your password stays unchanged.",
	})
}

// SendPasswordChanged confirms a completed reset. Per OWASP it never
// contains the password, and it gives the owner a way back in if the
// change wasn't theirs.
func SendPasswordChanged(ctx context.Context, m Mailer, to string, at time.Time) error {
	return send(ctx, m, to, "Your "+productName+" password was changed", emailContent{
		Heading:   "Your password was changed",
		Intro:     "The password for " + to + " was changed on " + at.UTC().Format("2 January 2006 at 15:04 UTC") + ". For your security, every device that was signed in has been signed out.",
		PlainTail: "If you made this change, there's nothing else to do.",
		CTALabel:  "Sign in",
		CTAURL:    appURL + "/login?email=" + url.QueryEscape(to),
		Footnote:  "If you didn't change your password, reset it right away from the sign-in page and contact your administrator.",
	})
}
