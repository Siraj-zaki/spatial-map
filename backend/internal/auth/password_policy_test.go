package auth

import "testing"

func TestValidatePassword_TooShort(t *testing.T) {
	cases := []string{"", "a", "1234567", "elevenchars"}
	for _, pw := range cases {
		if err := ValidatePassword(pw); err == nil {
			t.Errorf("expected rejection for %q (< 12 chars)", pw)
		}
	}
}

func TestValidatePassword_CommonExactMatch(t *testing.T) {
	cases := []string{"password1234", "qwertyuiop12", "iloveyou1234"}
	for _, pw := range cases {
		err := ValidatePassword(pw)
		if err == nil {
			t.Errorf("expected rejection for common exact %q", pw)
			continue
		}
		if err.Error() != "password is too common — pick something less predictable" {
			t.Errorf("wrong error for %q: %v", pw, err)
		}
	}
}

func TestValidatePassword_CommonSubstring(t *testing.T) {
	// These beat the length + diversity checks but contain a common token.
	// Every case has ≥12 chars and 3+ character classes.
	cases := []string{
		"MyPassword12!",
		"QwertyLogin1!",
		"WelcomeUser22",
		"AdMiN12345678!",
	}
	for _, pw := range cases {
		if err := ValidatePassword(pw); err == nil {
			t.Errorf("expected substring block for %q", pw)
		}
	}
}

func TestValidatePassword_SingleClassRejected(t *testing.T) {
	cases := []string{
		"abcdefghijkl", // lowercase only
		"ABCDEFGHIJKL", // uppercase only
		"123456789012", // digits only
		"!@#$%^&*()_+", // symbols only
		"abcdefgh1234", // lower + digits = only 2 classes
	}
	for _, pw := range cases {
		if err := ValidatePassword(pw); err == nil {
			t.Errorf("expected diversity rejection for %q", pw)
		}
	}
}

func TestValidatePassword_HappyPath(t *testing.T) {
	cases := []string{
		"MyStr0ng!Passphrase",
		"CorrectHorse42!",
		"summerBreeze2026",          // lower + upper + digits
		"Purple Monkey Dishwasher!", // upper + lower + symbols (space, !)
	}
	for _, pw := range cases {
		if err := ValidatePassword(pw); err != nil {
			t.Errorf("expected %q to be accepted, got: %v", pw, err)
		}
	}
}
