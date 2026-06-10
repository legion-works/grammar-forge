// Package ltcompat serves a LanguageTool-compatible /v2/check directly from
// the bridge — the LT-protocol front door without a LanguageTool container.
package ltcompat

// byteToUTF16Offset converts a byte offset into text to a UTF-16 code-unit
// offset. LanguageTool's wire offsets are Java String indices (UTF-16): a
// 2-byte 'é' is ONE unit, a 4-byte emoji is TWO (surrogate pair). Offsets
// past the end clamp to the total length; negative clamps to 0. Mid-rune
// offsets count the rune they fall inside as not-yet-passed (callers produce
// rune-aligned spans; clamping is belt-and-braces, not an API).
func byteToUTF16Offset(text string, byteOffset int) int {
	if byteOffset <= 0 {
		return 0
	}
	units := 0
	for i, r := range text {
		if i >= byteOffset {
			return units
		}
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}
