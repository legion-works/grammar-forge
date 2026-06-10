package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// ---- Rule 1: proximity-agreement restore ----

func TestRepairProximityAgreementFlipRevertsNorFlip(t *testing.T) {
	// Golden case 118's class: proximity agreement "nor the employees were"
	// is correct as written; the LLM flips were->was. The rule must revert.
	original := "Neither the manager nor the employees were aware of the change."
	corrected := "Neither the manager nor the employees was aware of the change."
	require.Equal(t, original, RepairProximityAgreementFlip(original, corrected))
}

func TestRepairProximityAgreementFlipKeepsWantedNeitherOfFix(t *testing.T) {
	// Golden case 70: "Neither of the answers were" -> "was" is a WANTED fix.
	// "Neither" contains "or" as a substring but there is NO whole token
	// nor/or, so the rule must not trigger (token match, not substring).
	original := "Neither of the answers were correct."
	corrected := "Neither of the answers was correct."
	require.Equal(t, corrected, RepairProximityAgreementFlip(original, corrected))
}

func TestRepairProximityAgreementFlipKeepsWantedListOfFix(t *testing.T) {
	// Golden case 69: "The list of items are" -> "is" is a WANTED fix.
	// No nor/or token anywhere -> untouched.
	original := "The list of items are on the desk."
	corrected := "The list of items is on the desk."
	require.Equal(t, corrected, RepairProximityAgreementFlip(original, corrected))
}

func TestRepairProximityAgreementFlipIgnoresSingularToPlural(t *testing.T) {
	// Golden case 4 direction: singular->plural fixes are never over-edits
	// of this class; the rule only handles plural->singular.
	original := "My friends is coming over tonight."
	corrected := "My friends are coming over tonight."
	require.Equal(t, corrected, RepairProximityAgreementFlip(original, corrected))
}

func TestRepairProximityAgreementFlipKeepsFixWhenNearestNounSingular(t *testing.T) {
	// Reversed conjuncts: "nor the employee were" is WRONG as written
	// (nearest conjunct singular); the LLM's were->was is a genuine fix.
	// Guard B (plural-looking nearest token) must keep it.
	original := "Neither the managers nor the employee were aware of the change."
	corrected := "Neither the managers nor the employee was aware of the change."
	require.Equal(t, corrected, RepairProximityAgreementFlip(original, corrected))
}

func TestRepairProximityAgreementFlipPreservesTrailingPunctuation(t *testing.T) {
	// Verb carries sentence-final punctuation: the tokens are "were."/"was.".
	// The rule compares the punctuation-trimmed cores and reverts the whole
	// token, keeping the trailing period.
	original := "Either the manager or the employees were."
	corrected := "Either the manager or the employees was."
	require.Equal(t, original, RepairProximityAgreementFlip(original, corrected))
}

func TestRepairProximityAgreementFlipRevertsOnlyTheFlipInMultiEditOutput(t *testing.T) {
	// The LLM output may contain OTHER (wanted) edits alongside the flip;
	// only the flip is reverted, the spelling fix survives.
	original := "Neither the manager nor the employees were awere of the change." //nolint:misspell
	corrected := "Neither the manager nor the employees was aware of the change."
	want := "Neither the manager nor the employees were aware of the change."
	require.Equal(t, want, RepairProximityAgreementFlip(original, corrected))
}

func TestRepairProximityAgreementFlipNoOpOnIdenticalText(t *testing.T) {
	s := "Neither the manager nor the employees were aware of the change."
	require.Equal(t, s, RepairProximityAgreementFlip(s, s))
}

// ---- helpers ----

func TestIsPluralLookingNoun(t *testing.T) {
	require.True(t, isPluralLookingNoun("employees"))
	require.True(t, isPluralLookingNoun("dogs,"))      // trailing punct trimmed
	require.False(t, isPluralLookingNoun("boss"))      // ss
	require.False(t, isPluralLookingNoun("manager's")) // possessive
	require.False(t, isPluralLookingNoun("is"))        // too short
	require.False(t, isPluralLookingNoun("Paris1s"))   // non-letter rune
}

// ---- Rule 2: proper-noun comma restore ----

func TestRepairProperNounCommaRestructureGolden91(t *testing.T) {
	// Golden case 91: the LLM rewrites "paris in france" -> "Paris, France,"
	// fusing the WANTED capitalization with an UNWANTED comma restructure.
	// The rule restores the preposition while keeping the capitalization.
	original := "we flew to paris in france last april."
	corrected := "We flew to Paris, France, last April."
	want := "We flew to Paris in France last April."
	require.Equal(t, want, RepairProperNounCommaRestructure(original, corrected))
}

func TestRepairProperNounCommaRestructureKeepsRealAppositive(t *testing.T) {
	// The original already uses the comma form -> there is no "x <prep> y"
	// in the original, so the rule must not fire.
	original := "He lives in springfield, ohio, near the lake."
	corrected := "He lives in Springfield, Ohio, near the lake."
	require.Equal(t, corrected, RepairProperNounCommaRestructure(original, corrected))
}

func TestRepairProperNounCommaRestructureRestoresOriginalComma(t *testing.T) {
	// The original had a comma AFTER the preposition form; the revert keeps it.
	original := "we met at tower of london, then left."
	corrected := "We met at Tower, London, then left."
	want := "We met at Tower of London, then left."
	require.Equal(t, want, RepairProperNounCommaRestructure(original, corrected))
}

func TestRepairProperNounCommaRestructureIgnoresUnlistedPreposition(t *testing.T) {
	// "near" is not in the preposition set -> conservative no-op.
	original := "we flew to paris near france last april."
	corrected := "We flew to Paris, France, last April."
	require.Equal(t, corrected, RepairProperNounCommaRestructure(original, corrected))
}

func TestRepairProperNounCommaRestructureRequiresWordBoundary(t *testing.T) {
	// "paris in france" appears only as a SUBSTRING of "mcparis in france";
	// the boundary check must reject it.
	original := "we flew to mcparis in france last april."
	corrected := "We flew to McParis, France, last April."
	require.Equal(t, corrected, RepairProperNounCommaRestructure(original, corrected))
}

func TestRepairProperNounCommaRestructureNoOpWithoutCommaPair(t *testing.T) {
	original := "we flew to paris in france last april."
	corrected := "We flew to Paris in France last April."
	require.Equal(t, corrected, RepairProperNounCommaRestructure(original, corrected))
}

// ---- framework ----

func TestDefaultOverEditRulesContainsBothRules(t *testing.T) {
	require.Len(t, DefaultOverEditRules(), 2)
}

func TestOverEditRuleChainComposesAndIsIdempotent(t *testing.T) {
	// Both rule classes in one input: the chain repairs both, and applying
	// the chain to its own output changes nothing (idempotent).
	original := "neither the manager nor the employees were in paris in france."
	corrected := "Neither the manager nor the employees was in Paris, France."
	apply := func(orig, corr string) string {
		for _, rule := range DefaultOverEditRules() {
			corr = rule(orig, corr)
		}
		return corr
	}
	want := "Neither the manager nor the employees were in Paris in France."
	once := apply(original, corrected)
	require.Equal(t, want, once)
	require.Equal(t, once, apply(original, once), "repair must be idempotent")
}
