package auth

import (
	"testing"
	"time"
)

// TestDummyVerify_AlwaysFalse documents the contract: the return is fixed
// at false so callers can plug it into the "user not found" login branch
// without needing to check the result. Its only purpose is to burn CPU
// matching what a real VerifyPassword would spend, so the response time
// doesn't reveal whether the email is registered.
func TestDummyVerify_AlwaysFalse(t *testing.T) {
	if DummyVerify("") {
		t.Fatal("empty password: want false")
	}
	if DummyVerify("anything") {
		t.Fatal("real password: want false")
	}
	if DummyVerify("login-timing-defence") {
		// Even for the plaintext used to seed the dummy hash: we don't
		// want this call to accidentally succeed if the seed changes.
		t.Fatal("seed plaintext: want false")
	}
}

// TestDummyVerify_TakesRealTime is a smoke check that DummyVerify actually
// burns bcrypt-scale CPU. Cost 10 lands around 60-80ms on modern hardware;
// we assert ≥10ms to give slow CI a comfortable margin. If this drops to
// microseconds, the timing side-channel is back — an attacker can once
// again distinguish "user exists" from "user missing" by measuring login
// latency.
func TestDummyVerify_TakesRealTime(t *testing.T) {
	start := time.Now()
	DummyVerify("any-password-goes-here")
	elapsed := time.Since(start)
	if elapsed < 10*time.Millisecond {
		t.Fatalf("DummyVerify returned in %v, expected ≥10ms — timing side-channel re-opened", elapsed)
	}
}

// TestDummyVerify_MatchesVerifyPasswordCost pins the two paths to the same
// order of magnitude. If a future refactor swaps bcrypt for a fast hash on
// one path but not the other, this test surfaces the drift.
func TestDummyVerify_MatchesVerifyPasswordCost(t *testing.T) {
	hash, err := HashPassword("real-password")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	start := time.Now()
	VerifyPassword(hash, "wrong-guess")
	realCost := time.Since(start)

	start = time.Now()
	DummyVerify("wrong-guess")
	dummyCost := time.Since(start)

	// Ratio bounded on both sides: dummy shouldn't be more than 3x slower
	// nor 3x faster than the real path. On CI the jitter can be wide, so
	// we allow a generous window — the point is to catch outright drift,
	// not micro-variation.
	if dummyCost > realCost*3 || realCost > dummyCost*3 {
		t.Fatalf("dummy vs real cost drift: real=%v dummy=%v (want within 3x)", realCost, dummyCost)
	}
}
