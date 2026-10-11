package auth

import "golang.org/x/crypto/bcrypt"

// bcryptCost is the work factor for password hashing. Cost 10 is the bcrypt
// default and lands in the ~60-80ms range on modern hardware — enough to slow
// brute force without making login feel laggy.
const bcryptCost = 10

// dummyHash is a valid bcrypt hash used by DummyVerify to burn the same CPU
// as a real password check when the user doesn't exist. Precomputed once at
// package init so per-request cost is just the CompareHashAndPassword call,
// not the (much slower) GenerateFromPassword. Value is opaque and never
// matches any password a caller might submit.
var dummyHash []byte

func init() {
	// Fail loudly if bcrypt.GenerateFromPassword panics — the login timing
	// defence is load-bearing and shipping without it would silently reopen
	// the enumeration side-channel.
	h, err := bcrypt.GenerateFromPassword([]byte("login-timing-defence"), bcryptCost)
	if err != nil {
		panic("auth: precompute dummy hash: " + err.Error())
	}
	dummyHash = h
}

// HashPassword returns a bcrypt hash of the given plaintext password.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// VerifyPassword reports whether the plaintext matches the stored bcrypt hash.
func VerifyPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// DummyVerify runs a bcrypt compare against a precomputed hash so its CPU
// cost matches a real VerifyPassword. Call this on the "user not found"
// branch of login to close the timing side-channel that would otherwise
// let an attacker enumerate valid emails. The return value is always false
// but the call is not optimizable away — bcrypt.CompareHashAndPassword is
// forced to walk the full hash before deciding.
func DummyVerify(password string) bool {
	_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
	return false
}
