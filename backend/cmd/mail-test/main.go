// mail-test sends a real transactional email using the current
// SGV_MAIL.* config so operators can verify SMTP credentials without
// running the full signup flow.
//
// Usage:
//
//	SGV_CONFIG=config.dev.yaml go run ./cmd/mail-test you@example.com
//
// Reads the same koanf-backed Config the API uses, so if this succeeds
// the OTP path will succeed too. Failures print the raw SMTP error
// (auth failure / DNS / TLS handshake / etc.) so you can debug without
// digging into API logs.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/config"
	"github.com/Siraj-zaki/spatial-map/backend/internal/mailer"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: mail-test <recipient-email>")
		os.Exit(2)
	}
	to := strings.TrimSpace(os.Args[1])

	path := os.Getenv("SGV_CONFIG")
	if path == "" {
		path = "config.dev.yaml"
	}
	cfg, err := config.Load(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load config:", err)
		os.Exit(1)
	}

	fmt.Println("mailer config:")
	fmt.Println("  host:     ", nonEmpty(cfg.Mail.Host, "(empty — will use CONSOLE mailer)"))
	fmt.Println("  port:     ", cfg.Mail.Port)
	fmt.Println("  username: ", nonEmpty(cfg.Mail.Username, "(empty)"))
	fmt.Println("  from:     ", nonEmpty(cfg.Mail.From, "(empty)"))
	fmt.Println("  from name:", nonEmpty(cfg.Mail.FromName, "(empty)"))
	if cfg.Mail.Host == "" {
		fmt.Println()
		fmt.Println("No SMTP host — running console mailer. To send a real email,")
		fmt.Println("set SGV_MAIL.HOST/PORT/USERNAME/PASSWORD/FROM in your config or env.")
	}
	fmt.Println()

	m := mailer.New(mailer.Config{
		From:     cfg.Mail.From,
		FromName: cfg.Mail.FromName,
		Host:     cfg.Mail.Host,
		Port:     cfg.Mail.Port,
		Username: cfg.Mail.Username,
		Password: cfg.Mail.Password,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	subject := "Spatial Map — mailer test"
	text := "This is a mailer-test message from the Spatial Map backend.\n" +
		"If you're reading this, SMTP is wired correctly and the OTP flow will work.\n\n" +
		"Sent at " + time.Now().UTC().Format(time.RFC3339)
	html := "<h2>Mailer test</h2><p>SMTP is wired correctly.</p><p><small>Sent at " +
		time.Now().UTC().Format(time.RFC3339) + "</small></p>"

	fmt.Printf("sending to %s ...\n", to)
	if err := m.Send(ctx, mailer.Message{
		To:       to,
		Subject:  subject,
		TextBody: text,
		HTMLBody: html,
	}); err != nil {
		slog.Error("send failed", "error", err)
		fmt.Fprintln(os.Stderr, "\nFAILED:", err)
		fmt.Fprintln(os.Stderr, "\nCommon causes:")
		fmt.Fprintln(os.Stderr, "  * Wrong host/port for the provider (e.g. Gmail is smtp.gmail.com:587).")
		fmt.Fprintln(os.Stderr, "  * Bad username/password. Gmail needs an App Password, not the account pw.")
		fmt.Fprintln(os.Stderr, "  * From address not verified with the provider (Resend/SES/Postmark).")
		fmt.Fprintln(os.Stderr, "  * Firewall blocking outbound SMTP.")
		os.Exit(1)
	}
	fmt.Println("OK — sent. Check the recipient's inbox (and spam folder).")
}

func nonEmpty(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}
