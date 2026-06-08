//go:build cgo

package harperffi

/*
#include <stdlib.h>
#include "harper_shim.h"
*/
import "C"

import (
	"os"
	"time"
)

// defaultUserDictPollInterval is how often the watcher checks the user
// dictionary file's modification time. Hot-reload is best-effort and not
// latency-critical, so a coarse interval keeps the poll cheap. Each Harper
// captures it into h.pollInterval at construction (tests may set a shorter
// per-instance interval), so the watcher never reads a shared mutable global.
const defaultUserDictPollInterval = 5 * time.Second

// watchUserDict polls opts.UserDictPath's modification time and, on change,
// rebuilds the cached LintGroup (and dict) and frees the old handles. It exits
// when done is closed (by Close); done is passed in (not read from the struct)
// so Close never races the watcher on the field. A missing file is treated as a
// stable sentinel (the group already behaves as curated-only); when the file
// later appears or is edited, the mtime change triggers a rebuild. The new
// handles are built OUTSIDE the lock (slow); only the swap+free of the old
// handles runs under h.mu, so a concurrent Correct never observes a half-freed
// group (see reloadGroup).
func (h *Harper) watchUserDict(done <-chan struct{}) {
	last := dictModTime(h.opts.UserDictPath)
	ticker := time.NewTicker(h.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			cur := dictModTime(h.opts.UserDictPath)
			if cur == last {
				continue
			}
			last = cur
			h.reloadGroup()
		}
	}
}

// reloadGroup rebuilds the LintGroup (and its merged-dictionary handle) from
// h.opts and atomically swaps them under the lock, freeing the previous group
// and dict. If the Harper was already closed (h.grp == nil) the freshly built
// group and dict are freed and not installed, so a reload racing Close never
// resurrects a freed handle.
func (h *Harper) reloadGroup() {
	freshGrp, freshDict := buildGroup(h.opts)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.grp == nil {
		// closed during rebuild: drop the new handles
		C.harper_free_lint_group(freshGrp)
		if freshDict != nil {
			C.harper_free_merged_dict(freshDict)
		}
		return
	}
	oldGrp, oldDict := h.grp, h.dict
	h.grp, h.dict = freshGrp, freshDict
	C.harper_free_lint_group(oldGrp)
	if oldDict != nil {
		C.harper_free_merged_dict(oldDict)
	}
}

// dictModTime returns the file's modification time in unix nanoseconds, or 0 if
// the file does not exist or cannot be stat'd (so an absent dict is a stable
// sentinel that differs from any real mtime once the file appears).
func dictModTime(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return fi.ModTime().UnixNano()
}
