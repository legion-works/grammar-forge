//go:build cgo

package harperffi

// Harper LintKind string keys, as returned by harper_get_lint_kind in the
// vendored harper-c fork (harper_core::linting::LintKind::to_string_key()).
// These keys are stable for the pinned harper-core version, so matching on the
// kind replaces the brittle message-substring classification the bridge used
// before. Only the kinds the bridge actually keys on are named here.
const (
	lintKindSpelling       = "Spelling"
	lintKindCapitalization = "Capitalization"
	lintKindEnhancement    = "Enhancement"
	lintKindWordChoice     = "WordChoice"
	lintKindStyle          = "Style"
	lintKindReadability    = "Readability"
)

// isStyleKind reports whether a Harper lint kind is a style / word-choice /
// readability enhancement that rewrites already-correct text for style (e.g.
// "very good" -> "excellent"). A grammar corrector must not emit these on the
// default path; a future picky-mode may resurface them (SPEC §6). Gating on the
// structured kind replaces the old "Vocabulary enhancement" message-substring
// match.
func isStyleKind(kind string) bool {
	switch kind {
	case lintKindEnhancement, lintKindWordChoice, lintKindStyle, lintKindReadability:
		return true
	default:
		return false
	}
}

// (Loanword gateability is decided by isLoanwordGateable in loanword_filter.go:
// it needs the message in addition to the kind because harper-core overloads
// the Capitalization kind.)
