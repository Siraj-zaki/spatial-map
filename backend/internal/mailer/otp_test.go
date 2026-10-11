package mailer

import (
	"strings"
	"testing"
)

// TestRenderEmail_BrandAndEscaping checks the shared layout carries the
// product name, the configured origin, and escapes interpolated text.
func TestRenderEmail_BrandAndEscaping(t *testing.T) {
	SetAppURL("https://app.example.test/")
	defer SetAppURL(DefaultAppURL)

	text, html := renderEmail(emailContent{
		Heading:  "Reset <now>",
		Intro:    "intro",
		Code:     "123456",
		CTALabel: "Sign in",
		CTAURL:   appURL + "/login",
		Footnote: "foot",
	})
	for _, want := range []string{"Spatial Map", "123456", "https://app.example.test/login"} {
		if !strings.Contains(text, want) {
			t.Errorf("text body missing %q", want)
		}
		if !strings.Contains(html, want) {
			t.Errorf("html body missing %q", want)
		}
	}
	if strings.Contains(html, "Reset <now>") || !strings.Contains(html, "Reset &lt;now&gt;") {
		t.Error("heading was not HTML-escaped")
	}
	if !strings.Contains(html, `href="https://app.example.test"`) {
		t.Error("header link should point at the configured origin (trailing slash trimmed)")
	}
	if strings.Contains(html, "spatialmap") || strings.Contains(text, "spatialmap") {
		t.Error("email must not reference the old hosted product")
	}
}

// TestSetAppURL_IgnoresEmpty keeps an unset config value from producing
// relative links in emails.
func TestSetAppURL_IgnoresEmpty(t *testing.T) {
	SetAppURL("https://keep.example.test")
	defer SetAppURL(DefaultAppURL)
	SetAppURL("  ")
	if appURL != "https://keep.example.test" {
		t.Fatalf("appURL = %q, want unchanged", appURL)
	}
}
