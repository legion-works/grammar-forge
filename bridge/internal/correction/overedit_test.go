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

// ---- Rule 3: mid-word case flip revert ----

func TestRepairMidWordCaseFlipRevertsMeasuredBug(t *testing.T) {
	// Measured live 2026-06-11 on Gemma-4 QAT at temp 0: the model emits
	// mid-word case corruption. The wanted sentence-case "it"->"It" must
	// survive; the unwanted "auto-detectS" trailing-letter uppercase must
	// be reverted.
	original := "it auto-detects the amount of fans at start, so it controls all the fans rather than just the first one."
	corrected := "It auto-detectS the amount of fans at start, so it controls all the fans rather than just the first one."
	want := "It auto-detects the amount of fans at start, so it controls all the fans rather than just the first one."
	require.Equal(t, want, RepairMidWordCaseFlip(original, corrected))
}

func TestRepairMidWordCaseFlipKeepsSentenceCaseFix(t *testing.T) {
	// Sentence-initial "it"->"It" is a wanted grammar fix. The first rune
	// differs ('i' vs 'I') so the rule must NOT revert it.
	original := "it works."
	corrected := "It works."
	require.Equal(t, corrected, RepairMidWordCaseFlip(original, corrected))
}

func TestRepairMidWordCaseFlipKeepsProperNounFix(t *testing.T) {
	// Proper-noun fixes ("paris"->"Paris", "june"->"June") flip the first
	// rune; they must survive untouched.
	original := "we visited paris in june."
	corrected := "We visited Paris in June."
	require.Equal(t, corrected, RepairMidWordCaseFlip(original, corrected))
}

func TestRepairMidWordCaseFlipRevertsWithTrailingPunctuation(t *testing.T) {
	// Trailing period must not block the revert. Cores "auto-detects"/
	// "auto-detectS" are compared; the period is the matching tail on both.
	original := "the fan auto-detects."
	corrected := "the fan auto-detectS."
	want := "the fan auto-detects."
	require.Equal(t, want, RepairMidWordCaseFlip(original, corrected))
}

func TestRepairMidWordCaseFlipSkipsWhenTailsDiffer(t *testing.T) {
	// Punctuation also changed ("," added on the corrected side). The edit
	// is not a bare case flip; leave the corrected region alone.
	original := "auto-detects"
	corrected := "auto-detectS,"
	require.Equal(t, corrected, RepairMidWordCaseFlip(original, corrected))
}

func TestRepairMidWordCaseFlipNoOpOnIdenticalText(t *testing.T) {
	s := "it auto-detects. we visited paris in june."
	require.Equal(t, s, RepairMidWordCaseFlip(s, s))
}

func TestRepairMidWordCaseFlipMultibyteSafety(t *testing.T) {
	// "café" / "cafÉ": first rune 'c' is byte-identical, mid-word 'é'/'É'
	// is the case difference. Revert to "café". EqualFold handles Unicode
	// (é == É), first-rune check is rune-based (multibyte-safe).
	original := "the café reopens"
	corrected := "the cafÉ reopens"
	want := "the café reopens"
	require.Equal(t, want, RepairMidWordCaseFlip(original, corrected))
}

func TestRepairMidWordCaseFlipIPhoneTradeOff(t *testing.T) {
	// Accepted precision-first trade-off: a legit "iphone"->"iPhone" fix
	// is reverted by this rule (first rune 'i' is byte-identical, mid-word
	// 'p'/'P' flip triggers the revert). The measured Gemma-4 QAT mid-word
	// case corruption is high-frequency; iPhone is rare and the reversion
	// is recoverable by the user with one extra accept. Documented in the
	// rule's comment. Direction guard: mid-word 'p'/'P' IS lower→upper
	// (the measured direction), so the iPhone revert still fires.
	original := "i bought an iphone"
	corrected := "I bought an iPhone"
	want := "I bought an iphone"
	require.Equal(t, want, RepairMidWordCaseFlip(original, corrected))
}

func TestRepairMidWordCaseFlipKeepsStuckCapsFix(t *testing.T) {
	// "THis" -> "This" is a UPPER->LOWER stuck-caps fix, the OPPOSITE
	// direction from the measured corruption (which is lower->upper:
	// "auto-detects" -> "auto-detectS"). The direction guard must NOT
	// revert upper->lower flips — they are genuine grammar fixes.
	original := "THis is fine."
	corrected := "This is fine."
	require.Equal(t, corrected, RepairMidWordCaseFlip(original, corrected))
}

func TestRepairMidWordCaseFlipKeepsAllCapsToSentenceCaseFix(t *testing.T) {
	// "IT" -> "It" is a UPPER->LOWER all-caps-to-sentence-case fix
	// (typed-Shift scenario). Same direction guard: keep it.
	original := "IT was raining."
	corrected := "It was raining."
	require.Equal(t, corrected, RepairMidWordCaseFlip(original, corrected))
}

func TestRepairMidWordCaseFlipSkipsInsertedFoldDuplicate(t *testing.T) {
	// Fold alignment with an inserted case-changed token: orig has 2
	// tokens, corr has 3. The case-fold aligner pairs orig[0] with the
	// LATER "foo" at corr[2] (leftmost-match) and orig[1] with corr[3]
	// — wait, corr[1] is "foo" and orig[1] is "bar". So matches are
	// (0,0) for "foo"/"fOo" and (1,2) for "bar"/"bar". The (0,0) pair
	// has an unbalanced gap AFTER it (tail 1 vs 2) and an unbalanced
	// gap before (1,2) (1 vs 2). Without the balanced-gap guard the
	// rule would splice the orig "foo" over the inserted "fOo" and
	// delete the LLM's legitimate edit. With the guard, both pairs
	// are skipped and the corrected text is preserved.
	original := "foo bar"
	corrected := "fOo foo bar"
	require.Equal(t, corrected, RepairMidWordCaseFlip(original, corrected))
}

// ---- framework ----

func TestDefaultOverEditRulesContainsAllMeasuredRules(t *testing.T) {
	chain := DefaultOverEditRules()
	require.Len(t, chain, 3)
}

func TestOverEditRuleChainComposesAndIsIdempotent(t *testing.T) {
	// All three measured rule classes in one input: the chain repairs all,
	// and applying the chain to its own output changes nothing (idempotent).
	original := "neither the manager nor the employees were in paris in france. it auto-detects."
	corrected := "Neither the manager nor the employees was in Paris, France. It auto-detectS."
	apply := func(orig, corr string) string {
		for _, rule := range DefaultOverEditRules() {
			corr = rule(orig, corr)
		}
		return corr
	}
	want := "Neither the manager nor the employees were in Paris in France. It auto-detects."
	once := apply(original, corrected)
	require.Equal(t, want, once)
	require.Equal(t, once, apply(original, once), "repair must be idempotent")
}
