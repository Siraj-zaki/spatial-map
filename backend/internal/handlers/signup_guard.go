package handlers

import "strings"

// Signup abuse guards (auth.go): one account per real Gmail inbox, no
// throwaway inboxes, and at most 3 new accounts per network per day. Off by
// default — turn it on with auth.signup_guard (SGV_AUTH.SIGNUP_GUARD=true)
// when public sign-up is open to the internet.
//
// Gmail delivers le.d.ao.0.0.8@gmail.com, ledao008+trial2@gmail.com and
// LeDao008@googlemail.com to the same inbox, so each looks like a new
// address to a plain uniqueness check — the classic free-trial farm. The
// OTP step doesn't stop it (every variant receives the code), so signup
// compares the inbox, not the address. The users table keeps the address
// the person typed; the identity is computed (here and in the
// GmailInboxHasUser query).

// signupGuard is set once at start-up (SetSignupGuard, from main.go).
var signupGuard bool

// SetSignupGuard turns the sign-up abuse guards on or off.
func SetSignupGuard(on bool) { signupGuard = on }

// gmailIdentity is the inbox a Gmail address delivers to — the local part
// without dots or a +suffix — or "" for any other domain.
func gmailIdentity(email string) string {
	at := strings.LastIndex(email, "@")
	if at <= 0 {
		return ""
	}
	local, domain := strings.ToLower(email[:at]), strings.ToLower(email[at+1:])
	if domain != "gmail.com" && domain != "googlemail.com" {
		return ""
	}
	if plus := strings.Index(local, "+"); plus >= 0 {
		local = local[:plus]
	}
	return strings.ReplaceAll(local, ".", "")
}

// isDisposableEmail reports an address at a throwaway-inbox service (or a
// subdomain of one).
func isDisposableEmail(email string) bool {
	at := strings.LastIndex(email, "@")
	if at <= 0 {
		return false
	}
	domain := strings.ToLower(email[at+1:])
	for {
		if disposableDomains[domain] {
			return true
		}
		dot := strings.Index(domain, ".")
		if dot < 0 {
			return false
		}
		domain = domain[dot+1:]
	}
}

// disposableDomains — the common throwaway-inbox services. Not exhaustive
// (new ones appear daily); it stops casual trial farming, and the per-IP
// daily cap covers the rest.
var disposableDomains = map[string]bool{
	"10minutemail.com": true, "10minutemail.net": true, "20minutemail.com": true, "33mail.com": true, "anonaddy.me": true,
	"burnermail.io": true, "byom.de": true, "chacuo.net": true, "dispostable.com": true, "dropmail.me": true,
	"emailondeck.com": true, "emltmp.com": true, "fakeinbox.com": true, "fakemail.net": true, "getairmail.com": true,
	"getnada.com": true, "guerrillamail.biz": true, "guerrillamail.com": true, "guerrillamail.de": true, "guerrillamail.info": true,
	"guerrillamail.net": true, "guerrillamail.org": true, "guerrillamailblock.com": true, "grr.la": true, "harakirimail.com": true,
	"inboxbear.com": true, "inboxkitten.com": true, "jetable.org": true, "mail-temp.com": true, "mail.tm": true,
	"mailcatch.com": true, "maildrop.cc": true, "mailinator.com": true, "mailinator.net": true, "mailinator2.com": true,
	"mailnesia.com": true, "mailpoof.com": true, "mailsac.com": true, "mailtemp.net": true, "mintemail.com": true,
	"moakt.com": true, "mohmal.com": true, "mytemp.email": true, "mytrashmail.com": true, "nada.email": true,
	"nowmymail.com": true, "sharklasers.com": true, "spam4.me": true, "spamgourmet.com": true, "spambox.us": true,
	"tempail.com": true, "tempinbox.com": true, "tempmail.com": true, "tempmail.dev": true, "tempmail.net": true,
	"tempmail.plus": true, "tempmailo.com": true, "temp-mail.io": true, "temp-mail.org": true, "tempr.email": true,
	"throwawaymail.com": true, "tmail.ws": true, "tmailor.com": true, "tmpmail.net": true, "tmpmail.org": true,
	"trash-mail.com": true, "trashmail.com": true, "trashmail.de": true, "trashmail.net": true, "wegwerfmail.de": true,
	"yopmail.com": true, "yopmail.fr": true, "yopmail.net": true, "emailfake.com": true, "fexpost.com": true,
	"fextemp.com": true, "minuteinbox.com": true, "spamdecoy.net": true, "luxusmail.org": true, "1secmail.com": true,
	"1secmail.net": true, "1secmail.org": true, "mailbox.in.ua": true, "discard.email": true, "tempmailaddress.com": true,
}
