// lib.rs - GrammarForge vendored fork of hippietrail/harper-c.
//
// Exposes the harper-core linting engine over a C ABI. See ffi.rs for the
// exported functions and harper.h for the matching C declarations.

pub mod ffi; // This makes the functions in ffi.rs available to other modules
