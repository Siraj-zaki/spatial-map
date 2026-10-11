package cad

import (
	"strconv"
	"strings"
)

// A drawing does not always store text as the characters it draws. Two
// conventions, both older than Unicode and both still written by current
// releases, stand in for characters a text style could not otherwise
// reach: a `\U+` escape naming a code point outright, and the `%%`
// sequences that predate it for the handful of symbols a draughtsman
// needs on a keyboard that has none of them.
//
// Left alone they are not a cosmetic problem. Apartment-1.dwg labels
// every one of its rooms this way — 餐厅 is stored as `\U+9910\U+5385` —
// so a reader that passes the escape through names the dining room
// "\U+9910\U+5385" on the map, in the layer list and in every derived
// area. The characters are in the file; they are just not spelled as
// themselves.
//
// MTEXT adds a second language on top, because a paragraph can change
// font, height, colour and slant partway through a word. Those codes
// describe how the text looks and the model keeps only what it says, so
// they are removed rather than interpreted — with the exception of the
// ones that stand for a character, which are the whole reason for this
// file.
//
// This lives beside the entity model rather than in a reader because the
// conventions are the format family's, not one container's: DXF stores
// exactly the same escapes, so a DXF reader should call this and not
// reimplement it.

// Symbols the `%%` sequences stand for. `%%o` and `%%u` toggle overline
// and underline, which is styling the model has no place for, so they
// resolve to nothing rather than being left in the middle of a word.
var percentEscapes = map[byte]string{
	'd': "°", // degree
	'p': "±", // plus-or-minus
	'c': "⌀", // diameter
	'%': "%",
	'o': "",
	'u': "",
}

// MTEXT formatting codes that switch something on or off and take no
// argument, and so are two characters long exactly.
const mtextToggles = "OoLlKk"

// MTEXT formatting codes that carry an argument, which runs to the next
// semicolon: `\H2.5;` sets the height, `\fArial|b1;` the font.
const mtextArgumented = "CcFfHWTQAp"

// PlainText renders a single-line text value as the characters it stands
// for.
//
// Anything it does not recognise is passed through unchanged. That is the
// deliberate choice at every branch below: a label that keeps a stray
// escape is legible and obviously odd, where one mangled by a guess at
// some other code page is neither. `\M+` — the multi-byte code-page
// escape — is left alone for exactly that reason, since resolving it
// needs the code page the text style names and a wrong one produces
// confident nonsense.
func PlainText(s string) string { return unescape(s, false) }

// PlainMText renders a paragraph's value as its text, with the inline
// formatting removed.
//
// The result is the words in reading order, with paragraph breaks kept as
// newlines: it is what the drawing says, not what it looks like. Callers
// wanting the appearance would need to keep the codes and interpret them,
// which nothing here does.
func PlainMText(s string) string { return unescape(s, true) }

func unescape(s string, multiline bool) string {
	if !strings.ContainsAny(s, `\%{}`) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == '%' && i+2 < len(s) && s[i+1] == '%':
			sym, ok := percentEscapes[lower(s[i+2])]
			if !ok {
				break
			}
			b.WriteString(sym)
			i += 3
			continue

		// A brace groups a run so that formatting inside it is undone at
		// the end. It affects nothing that survives here, but it is
		// punctuation the reader would otherwise print.
		case multiline && (c == '{' || c == '}'):
			i++
			continue

		case c == '\\' && i+1 < len(s):
			if n := escapeAt(&b, s[i:], multiline); n > 0 {
				i += n
				continue
			}
		}
		b.WriteByte(c)
		i++
	}
	return b.String()
}

// escapeAt writes what the escape at the head of s stands for and returns
// its length, or returns zero to say it is not one — in which case the
// caller passes the backslash through as an ordinary character.
func escapeAt(b *strings.Builder, s string, multiline bool) int {
	if strings.HasPrefix(s, `\U+`) && len(s) >= 7 {
		r, err := strconv.ParseUint(s[3:7], 16, 32)
		if err != nil {
			return 0
		}
		b.WriteRune(rune(r))
		return 7
	}
	if !multiline {
		return 0
	}

	code := s[1]
	switch code {
	case 'P', 'X', 'N': // paragraph break, dimension break, column break
		b.WriteByte('\n')
		return 2
	case '~': // a space the layout may not break a line at
		b.WriteByte(' ')
		return 2
	case '\\', '{', '}': // the three characters the language needs escaped
		b.WriteByte(code)
		return 2
	}
	if strings.IndexByte(mtextToggles, code) >= 0 {
		return 2
	}

	// The rest carry an argument up to a semicolon. An unterminated one is
	// not a formatting code — it is a backslash in the middle of a
	// sentence, and dropping the rest of the paragraph on that reading
	// would lose real text.
	end := strings.IndexByte(s, ';')
	if end < 0 {
		return 0
	}
	if strings.IndexByte(mtextArgumented, code) >= 0 {
		return end + 1
	}

	// A stacked fraction is the one argument that is itself text: the
	// separator says how to draw the two halves, and both halves are words
	// the drawing means to say.
	if code == 'S' {
		body := s[2:end]
		for _, sep := range []string{"^", "#"} {
			body = strings.ReplaceAll(body, sep, "")
		}
		b.WriteString(body)
		return end + 1
	}
	return 0
}

func lower(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 'a' - 'A'
	}
	return c
}
