package cad

import "testing"

func TestPlainTextResolvesTheEscapesDrawingsActuallyUse(t *testing.T) {
	cases := []struct{ in, want, why string }{
		{"KITCHEN", "KITCHEN", "text with nothing to resolve is returned as it stands"},
		{`\U+9910\U+5385`, "餐厅", "Apartment-1 labels every room this way"},
		{`\U+9633 \U+53F0`, "阳 台", "an escape run can be interrupted by a literal"},
		{`90%%d`, "90°", "the degree sign predates the Unicode escape"},
		{`%%p0.5`, "±0.5", "as does plus-or-minus"},
		{`%%C50`, "⌀50", "the sequence letter is not case sensitive"},
		{`100%%%`, "100%", "a literal percent is written as an escape of its own"},
		{`%%uPLAN%%u`, "PLAN", "underline toggles carry no character"},

		// Everything below is passed through rather than guessed at. A
		// label that keeps a stray escape is legible and obviously odd; one
		// mangled by a guess at some other code page is neither.
		{`\M+5D0C8`, `\M+5D0C8`, "the code-page escape needs a code page we do not have"},
		{`\U+ZZZZ`, `\U+ZZZZ`, "four characters that are not hex are not a code point"},
		{`\U+91`, `\U+91`, "a truncated escape is left as written"},
		{`50% of`, "50% of", "a lone percent is not an escape"},
		{`A\B`, `A\B`, "a backslash is otherwise literal in single-line text"},
		{`\P`, `\P`, "the paragraph break belongs to MTEXT and means nothing here"},
	}
	for _, c := range cases {
		if got := PlainText(c.in); got != c.want {
			t.Errorf("PlainText(%q) = %q, want %q — %s", c.in, got, c.want, c.why)
		}
	}
}

func TestPlainMTextKeepsTheWordsAndDropsTheFormatting(t *testing.T) {
	cases := []struct{ in, want, why string }{
		{`Office\PB2.G.R-12`, "Office\nB2.G.R-12", "a room label and its number are one paragraph in two lines"},
		{`{\fArial|b1|i0;STORE}`, "STORE", "a font change and the group it applies to both disappear"},
		{`\H2.5x;\C1;RAMP`, "RAMP", "height and colour take an argument up to the semicolon"},
		{`\LPLAN\l`, "PLAN", "underline toggles take no argument"},
		{`1\S1/2;"`, `11/2"`, "a stacked fraction is text the drawing means to say"},
		{`\S+0.1^-0.1;`, "+0.1-0.1", "so is a stacked tolerance"},
		{`A\~B`, "A B", "the non-breaking space is still a space"},
		{`\U+5EFA\U+7B51`, "建筑", "the code-point escape works in a paragraph too"},
		{`90%%d`, "90°", "and so do the older symbol sequences, unescaped"},

		// A paragraph is written in a language, so its punctuation has to be
		// escaped to be read as itself. A path is the case where that is
		// easiest to get wrong in either direction: written properly it
		// round-trips, and written raw it is genuinely a paragraph break
		// followed by an underline — which is what AutoCAD draws too.
		{`C:\\Plans\\Level 2`, `C:\Plans\Level 2`, "an escaped backslash resolves to itself"},
		{`\{Level 2\}`, `{Level 2}`, "as do escaped braces, which are otherwise grouping"},
		{`C:\Plans`, "C:\nlans", `an unescaped backslash is the code it spells`},

		// An argument that never terminates is a backslash in a sentence,
		// not a formatting code. Reading it as one would swallow the rest of
		// the paragraph, which is real text.
		{`\Q45 degrees`, `\Q45 degrees`, "an unterminated argument is passed through whole"},
	}
	for _, c := range cases {
		if got := PlainMText(c.in); got != c.want {
			t.Errorf("PlainMText(%q) = %q, want %q — %s", c.in, got, c.want, c.why)
		}
	}
}
