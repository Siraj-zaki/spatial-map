// Package mailer sends transactional email (OTP codes, notifications).
//
// Two backends are supported:
//
//   - "smtp"    — plain net/smtp with STARTTLS/implicit-TLS auto-detected
//     from the port. Configured via SGV_MAIL.* env vars.
//   - "console" — logs the email body to stdout. This is the default when
//     no SMTP host is configured so the OTP flow always works in local
//     dev without operators having to set up an SMTP server first.
//
// The console backend also writes to slog so operators running the API
// container can grep the logs for a specific recipient's code — useful
// during triage when a user reports "I didn't get my code".
package mailer

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// Mailer sends a single email.
type Mailer interface {
	Send(ctx context.Context, msg Message) error
}

// Message is a single outbound email. HTMLBody is optional — when empty,
// the message is sent as text/plain.
type Message struct {
	To       string
	Subject  string
	TextBody string
	HTMLBody string
}

// Config describes the mailer backend.
type Config struct {
	// From is the envelope + header From address (e.g. "no-reply@example.com").
	From string
	// FromName is the human-readable name (e.g. "Spatial Map"). Optional.
	FromName string

	// SMTP fields. When Host is empty the console mailer is used.
	Host     string
	Port     int
	Username string
	Password string
}

// New returns a Mailer based on cfg. When cfg.Host is empty the returned
// mailer logs to stdout so dev environments always work.
func New(cfg Config) Mailer {
	if strings.TrimSpace(cfg.Host) == "" {
		return &consoleMailer{from: fromLine(cfg)}
	}
	return &smtpMailer{cfg: cfg}
}

// fromLine composes the RFC 5322 From header value.
func fromLine(cfg Config) string {
	from := cfg.From
	if from == "" {
		from = "no-reply@spatialmap.local"
	}
	if cfg.FromName == "" {
		return from
	}
	return fmt.Sprintf("%s <%s>", cfg.FromName, from)
}

// ---- console backend --------------------------------------------------------

type consoleMailer struct{ from string }

func (c *consoleMailer) Send(ctx context.Context, msg Message) error {
	slog.Info("mailer.console send",
		"from", c.from,
		"to", msg.To,
		"subject", msg.Subject,
		"body", msg.TextBody,
	)
	// Also write a decorated banner to stdout so the OTP is easy to spot
	// when tailing docker logs in dev.
	fmt.Printf("\n──────── EMAIL (dev console) ────────\n")
	fmt.Printf("From:    %s\n", c.from)
	fmt.Printf("To:      %s\n", msg.To)
	fmt.Printf("Subject: %s\n\n", msg.Subject)
	fmt.Printf("%s\n", msg.TextBody)
	fmt.Printf("─────────────────────────────────────\n\n")
	return nil
}

// ---- SMTP backend -----------------------------------------------------------

type smtpMailer struct{ cfg Config }

func (m *smtpMailer) Send(ctx context.Context, msg Message) error {
	if msg.To == "" {
		return errors.New("mailer: To is required")
	}
	addr := fmt.Sprintf("%s:%d", m.cfg.Host, m.cfg.Port)
	from := m.cfg.From
	if from == "" {
		return errors.New("mailer: SMTP.From is required")
	}

	// Compose a minimal MIME message. We deliberately keep this hand-rolled
	// so we don't take a dependency on a full email library for a single
	// transactional template.
	var body strings.Builder
	body.WriteString("From: " + fromLine(m.cfg) + "\r\n")
	body.WriteString("To: " + msg.To + "\r\n")
	body.WriteString("Subject: " + msg.Subject + "\r\n")
	body.WriteString("MIME-Version: 1.0\r\n")
	body.WriteString("Date: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\n")
	if msg.HTMLBody != "" {
		boundary := "sgv-boundary-" + time.Now().UTC().Format("20060102150405")
		body.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n")
		body.WriteString("--" + boundary + "\r\n")
		body.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		body.WriteString(msg.TextBody + "\r\n\r\n")
		body.WriteString("--" + boundary + "\r\n")
		body.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
		body.WriteString(msg.HTMLBody + "\r\n\r\n")
		body.WriteString("--" + boundary + "--\r\n")
	} else {
		body.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		body.WriteString(msg.TextBody + "\r\n")
	}

	// Auto-detect TLS mode from the port: 465 = implicit TLS, everything
	// else uses STARTTLS if available. This covers Gmail, SES, Mailgun,
	// Postmark, and self-hosted Postfix without further config.
	var auth smtp.Auth
	if m.cfg.Username != "" {
		auth = smtp.PlainAuth("", m.cfg.Username, m.cfg.Password, m.cfg.Host)
	}

	if m.cfg.Port == 465 {
		return sendImplicitTLS(addr, m.cfg.Host, from, msg.To, auth, []byte(body.String()))
	}
	return smtp.SendMail(addr, auth, from, []string{msg.To}, []byte(body.String()))
}

// sendImplicitTLS wraps net/smtp for the 465 (SMTPS) case which the stdlib
// SendMail helper doesn't natively cover.
func sendImplicitTLS(addr, host, from, to string, auth smtp.Auth, msg []byte) error {
	conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: host})
	if err != nil {
		return fmt.Errorf("smtp dial: %w", err)
	}
	defer conn.Close()
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		return fmt.Errorf("smtp client: %w", err)
	}
	defer c.Quit()
	if auth != nil {
		if ok, _ := c.Extension("AUTH"); ok {
			if err := c.Auth(auth); err != nil {
				return fmt.Errorf("smtp auth: %w", err)
			}
		}
	}
	if err := c.Mail(from); err != nil {
		return fmt.Errorf("smtp MAIL: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("smtp RCPT: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp close: %w", err)
	}
	return nil
}

// Keep net import referenced when TLS branch is compiled out on some builds.
var _ = net.Dial
