package handlers

import "testing"

func TestGmailIdentity(t *testing.T) {
	cases := map[string]string{
		"le.d.ao.0.0.8@gmail.com":   "ledao008",
		"LeDao008@GoogleMail.com":   "ledao008",
		"ledao008+trial2@gmail.com": "ledao008",
		"l.e.d.a.o+x.y@gmail.com":   "ledao",
		"waladi.widarno@gmail.com":  "waladiwidarno",
		"first.last@outlook.com":    "",
		"someone+tag@company.co":    "",
		"not-an-email":              "",
	}
	for in, want := range cases {
		if got := gmailIdentity(in); got != want {
			t.Errorf("gmailIdentity(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsDisposableEmail(t *testing.T) {
	for _, e := range []string{"x@mailinator.com", "x@YOPMAIL.com", "x@eu.guerrillamail.com"} {
		if !isDisposableEmail(e) {
			t.Errorf("%s should be disposable", e)
		}
	}
	for _, e := range []string{"x@gmail.com", "x@spatialmap.io", "x@mailinator.com.example.org", "bad"} {
		if isDisposableEmail(e) {
			t.Errorf("%s should not be disposable", e)
		}
	}
}
