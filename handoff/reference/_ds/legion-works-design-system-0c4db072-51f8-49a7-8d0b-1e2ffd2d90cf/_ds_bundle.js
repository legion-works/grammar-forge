/* @ds-bundle: {"format":4,"namespace":"LegionWorksDesignSystem_0c4db0","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"GlassPanel","sourcePath":"components/core/GlassPanel.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"Progress","sourcePath":"components/feedback/Progress.jsx"},{"name":"Spinner","sourcePath":"components/feedback/Spinner.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/feedback/Tooltip.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Radio","sourcePath":"components/forms/Radio.jsx"},{"name":"RadioGroup","sourcePath":"components/forms/Radio.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Textarea","sourcePath":"components/forms/Textarea.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"},{"name":"Dialog","sourcePath":"components/overlays/Dialog.jsx"},{"name":"KeyCap","sourcePath":"components/terminal/KeyCap.jsx"},{"name":"Prompt","sourcePath":"components/terminal/Prompt.jsx"},{"name":"StatusBar","sourcePath":"components/terminal/StatusBar.jsx"},{"name":"TerminalWindow","sourcePath":"components/terminal/TerminalWindow.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"bddd82a0314d","components/core/Button.jsx":"496c1bdf5aab","components/core/Card.jsx":"4ef0ea1064c4","components/core/GlassPanel.jsx":"ccd0041855a9","components/core/IconButton.jsx":"32721be60254","components/core/Tag.jsx":"28a0a938843b","components/feedback/Progress.jsx":"97affdd91e62","components/feedback/Spinner.jsx":"6243b34aced5","components/feedback/Toast.jsx":"26d34bf9fe03","components/feedback/Tooltip.jsx":"c0d72f67b47e","components/forms/Checkbox.jsx":"c6edce7c6628","components/forms/Input.jsx":"1f6c29c5aea7","components/forms/Radio.jsx":"ae33ddf0a75f","components/forms/Select.jsx":"6dc13eea6131","components/forms/Switch.jsx":"b4bb235e62be","components/forms/Textarea.jsx":"5bceda4a665b","components/navigation/Tabs.jsx":"c49024783abf","components/overlays/Dialog.jsx":"742c83b87272","components/terminal/KeyCap.jsx":"85509180e0e5","components/terminal/Prompt.jsx":"f68e546727c5","components/terminal/StatusBar.jsx":"8df735d8f06d","components/terminal/TerminalWindow.jsx":"0baf4a9fd2ca","ui_kits/blog/blog.jsx":"035257c4a287","ui_kits/dashboard/dashboard.jsx":"dbcae2968077","ui_kits/docs/docs.jsx":"9c2120197ef1","ui_kits/grammarforge/gf-popup.jsx":"298bd9d44418","ui_kits/landing/landing.jsx":"d1127a417e57","ui_kits/legion-chat/chat.jsx":"fd965b0fead9"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.LegionWorksDesignSystem_0c4db0 = window.LegionWorksDesignSystem_0c4db0 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Legion Works — Badge (status pill with optional dot)
 */
function Badge({
  children,
  tone = "neutral",
  dot = false,
  size = "md",
  style = {},
  ...rest
}) {
  const tones = {
    neutral: {
      fg: "var(--text-muted)",
      bg: "var(--glass-fill)",
      bd: "var(--border)"
    },
    accent: {
      fg: "var(--accent)",
      bg: "var(--accent-muted)",
      bd: "var(--border-accent)"
    },
    warm: {
      fg: "var(--accent-warm)",
      bg: "var(--accent-warm-muted)",
      bd: "color-mix(in oklab, var(--amber-400) 40%, transparent)"
    },
    success: {
      fg: "var(--success)",
      bg: "var(--success-muted)",
      bd: "color-mix(in oklab, var(--success) 40%, transparent)"
    },
    warning: {
      fg: "var(--warning)",
      bg: "var(--warning-muted)",
      bd: "color-mix(in oklab, var(--warning) 40%, transparent)"
    },
    danger: {
      fg: "var(--danger)",
      bg: "var(--danger-muted)",
      bd: "color-mix(in oklab, var(--danger) 40%, transparent)"
    },
    info: {
      fg: "var(--info)",
      bg: "var(--info-muted)",
      bd: "color-mix(in oklab, var(--info) 40%, transparent)"
    }
  };
  const t = tones[tone] || tones.neutral;
  const dims = size === "sm" ? {
    padding: "2px 8px",
    fontSize: "var(--text-2xs)",
    gap: 5
  } : {
    padding: "3px 10px",
    fontSize: "var(--text-xs)",
    gap: 6
  };
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: dims.gap,
      padding: dims.padding,
      fontFamily: "var(--font-mono)",
      fontSize: dims.fontSize,
      fontWeight: "var(--fw-medium)",
      letterSpacing: "0.03em",
      color: t.fg,
      background: t.bg,
      border: `1px solid ${t.bd}`,
      borderRadius: "var(--radius-pill)",
      lineHeight: 1.4,
      whiteSpace: "nowrap",
      ...style
    }
  }, rest), dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: "50%",
      background: t.fg,
      boxShadow: `0 0 6px ${t.fg}`
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  sm: {
    padding: "6px 12px",
    fontSize: "var(--text-sm)",
    height: 32,
    gap: 6
  },
  md: {
    padding: "9px 16px",
    fontSize: "var(--text-sm)",
    height: 40,
    gap: 8
  },
  lg: {
    padding: "12px 22px",
    fontSize: "var(--text-md)",
    height: 48,
    gap: 10
  }
};
function variantStyle(variant) {
  switch (variant) {
    case "primary":
      return {
        background: "var(--accent)",
        color: "var(--accent-ink)",
        border: "1px solid transparent",
        fontWeight: "var(--fw-semibold)"
      };
    case "warm":
      return {
        background: "var(--accent-warm)",
        color: "var(--text-on-accent)",
        border: "1px solid transparent",
        fontWeight: "var(--fw-semibold)"
      };
    case "secondary":
      return {
        background: "var(--glass-fill-strong)",
        color: "var(--text-strong)",
        border: "1px solid var(--glass-stroke)",
        backdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
        fontWeight: "var(--fw-medium)"
      };
    case "ghost":
      return {
        background: "transparent",
        color: "var(--text-body)",
        border: "1px solid transparent",
        fontWeight: "var(--fw-medium)"
      };
    case "danger":
      return {
        background: "var(--danger-muted)",
        color: "var(--danger)",
        border: "1px solid color-mix(in oklab, var(--danger) 40%, transparent)",
        fontWeight: "var(--fw-medium)"
      };
    default:
      return {};
  }
}

/**
 * Legion Works — Button
 */
function Button({
  children,
  variant = "primary",
  size = "md",
  disabled = false,
  block = false,
  iconLeft = null,
  iconRight = null,
  glow = false,
  style = {},
  ...rest
}) {
  const s = SIZES[size] || SIZES.md;
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const base = {
    display: block ? "flex" : "inline-flex",
    width: block ? "100%" : "auto",
    alignItems: "center",
    justifyContent: "center",
    gap: s.gap,
    minHeight: s.height,
    padding: s.padding,
    fontSize: s.fontSize,
    fontFamily: "var(--font-ui)",
    lineHeight: 1,
    letterSpacing: "0.01em",
    borderRadius: "var(--radius-md)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    transition: "background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease), box-shadow var(--dur-mid) var(--ease)",
    transform: active && !disabled ? "scale(0.98)" : "scale(1)",
    whiteSpace: "nowrap",
    userSelect: "none",
    ...variantStyle(variant)
  };
  if (!disabled && hover) {
    if (variant === "ghost") base.background = "var(--glass-fill)";else if (variant === "primary") base.background = "var(--accent-strong)";else if (variant === "secondary") base.borderColor = "var(--border-strong)";else base.filter = "brightness(1.06)";
    if (glow || variant === "primary") base.boxShadow = "var(--glow-cyan)";
    if (variant === "warm") base.boxShadow = "var(--glow-amber)";
  }
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    disabled: disabled,
    style: {
      ...base,
      ...style
    },
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setActive(false);
    },
    onMouseDown: () => setActive(true),
    onMouseUp: () => setActive(false)
  }, rest), iconLeft, children, iconRight);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/GlassPanel.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Legion Works — GlassPanel
 * The raw Liquid Glass surface primitive. Everything visual sits on it.
 */
function GlassPanel({
  children,
  strong = false,
  tint = "none",
  radius = "lg",
  padding = "5",
  glow = false,
  as = "div",
  style = {},
  ...rest
}) {
  const El = as;
  const tintBg = {
    none: "var(--glass-fill)",
    strong: "var(--glass-fill-strong)",
    cyan: "color-mix(in oklab, var(--cyan-400) 12%, var(--glass-fill))",
    amber: "color-mix(in oklab, var(--amber-400) 12%, var(--glass-fill))"
  };
  const bg = strong ? "var(--glass-fill-strong)" : tintBg[tint] || tintBg.none;
  const base = {
    position: "relative",
    background: bg,
    backdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
    WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
    border: "1px solid var(--glass-stroke)",
    borderRadius: `var(--radius-${radius})`,
    padding: `var(--space-${padding})`,
    boxShadow: glow ? "var(--shadow-lg), var(--glass-inner-shadow), var(--glow-cyan)" : "var(--shadow-lg), var(--glass-inner-shadow)",
    color: "var(--text-body)"
  };
  return /*#__PURE__*/React.createElement(El, _extends({
    style: {
      ...base,
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      padding: 1,
      background: "linear-gradient(180deg, var(--glass-stroke-top), transparent 42%)",
      WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
      WebkitMaskComposite: "xor",
      maskComposite: "exclude",
      pointerEvents: "none"
    }
  }), children);
}
Object.assign(__ds_scope, { GlassPanel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/GlassPanel.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Legion Works — Card
 * Structured content container. Glass by default; `solid` for
 * dense/long-form surfaces where glass would hurt legibility.
 */
function Card({
  children,
  eyebrow,
  title,
  footer,
  media,
  solid = false,
  interactive = false,
  padding = "5",
  style = {},
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const inner = /*#__PURE__*/React.createElement(React.Fragment, null, media && /*#__PURE__*/React.createElement("div", {
    style: {
      margin: `calc(var(--space-${padding}) * -1) calc(var(--space-${padding}) * -1) var(--space-4)`,
      borderTopLeftRadius: "inherit",
      borderTopRightRadius: "inherit",
      overflow: "hidden"
    }
  }, media), eyebrow && /*#__PURE__*/React.createElement("div", {
    className: "lw-eyebrow",
    style: {
      marginBottom: "var(--space-2)"
    }
  }, eyebrow), title && /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: "var(--text-xl)",
      marginBottom: "var(--space-2)"
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--text-body)",
      fontSize: "var(--text-sm)",
      lineHeight: "var(--lh-normal)"
    }
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "var(--space-4)",
      paddingTop: "var(--space-3)",
      borderTop: "1px solid var(--border)",
      display: "flex",
      alignItems: "center",
      gap: "var(--space-3)"
    }
  }, footer));
  if (solid) {
    const base = {
      background: "var(--bg-raised)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      padding: `var(--space-${padding})`,
      boxShadow: "var(--shadow-md)",
      transition: "border-color var(--dur-mid) var(--ease), transform var(--dur-mid) var(--ease)",
      cursor: interactive ? "pointer" : "default",
      transform: interactive && hover ? "translateY(-2px)" : "none",
      borderColor: interactive && hover ? "var(--border-strong)" : "var(--border)",
      ...style
    };
    return /*#__PURE__*/React.createElement("div", _extends({
      style: base,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false)
    }, rest), inner);
  }
  return /*#__PURE__*/React.createElement(__ds_scope.GlassPanel, _extends({
    padding: padding,
    glow: interactive && hover,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      cursor: interactive ? "pointer" : "default",
      transform: interactive && hover ? "translateY(-2px)" : "none",
      transition: "transform var(--dur-mid) var(--ease), box-shadow var(--dur-mid) var(--ease)",
      ...style
    }
  }, rest), inner);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  sm: 32,
  md: 40,
  lg: 48
};

/**
 * Legion Works — IconButton (square, icon-only)
 */
function IconButton({
  children,
  size = "md",
  variant = "ghost",
  disabled = false,
  active = false,
  label,
  style = {},
  ...rest
}) {
  const dim = SIZES[size] || SIZES.md;
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const variants = {
    ghost: {
      background: "transparent",
      color: "var(--text-muted)",
      border: "1px solid transparent"
    },
    glass: {
      background: "var(--glass-fill)",
      color: "var(--text-body)",
      border: "1px solid var(--glass-stroke)",
      backdropFilter: "blur(var(--glass-blur))",
      WebkitBackdropFilter: "blur(var(--glass-blur))"
    },
    solid: {
      background: "var(--accent)",
      color: "var(--accent-ink)",
      border: "1px solid transparent"
    }
  };
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: dim,
    height: dim,
    borderRadius: "var(--radius-md)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    transition: "background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease)",
    transform: press && !disabled ? "scale(0.94)" : "scale(1)",
    ...variants[variant]
  };
  if (active) {
    base.color = "var(--accent)";
    base.background = "var(--accent-muted)";
  }
  if (!disabled && hover && !active) {
    base.color = variant === "solid" ? base.color : "var(--text-strong)";
    if (variant !== "solid") base.background = "var(--glass-fill-strong)";else base.background = "var(--accent-strong)";
  }
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    "aria-label": label,
    title: label,
    disabled: disabled,
    style: {
      ...base,
      ...style
    },
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setPress(false);
    },
    onMouseDown: () => setPress(true),
    onMouseUp: () => setPress(false)
  }, rest), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Legion Works — Tag (removable label / filter chip)
 */
function Tag({
  children,
  onRemove,
  active = false,
  icon = null,
  style = {},
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 10px",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--text-xs)",
      fontWeight: "var(--fw-medium)",
      color: active ? "var(--accent)" : "var(--text-body)",
      background: active ? "var(--accent-muted)" : "var(--glass-fill)",
      border: `1px solid ${active ? "var(--border-accent)" : "var(--border)"}`,
      borderRadius: "var(--radius-sm)",
      cursor: onRemove || rest.onClick ? "pointer" : "default",
      transition: "border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)",
      borderColor: hover && (onRemove || rest.onClick) ? "var(--border-strong)" : undefined,
      ...style
    },
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, rest), icon, children, onRemove && /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-label": "Remove",
    onClick: e => {
      e.stopPropagation();
      onRemove(e);
    },
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 14,
      height: 14,
      padding: 0,
      marginLeft: 2,
      border: "none",
      background: "transparent",
      color: "var(--text-faint)",
      cursor: "pointer",
      fontSize: 13,
      lineHeight: 1,
      borderRadius: 3
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Progress.jsx
try { (() => {
/**
 * Legion Works — Progress (linear determinate/indeterminate)
 */
function Progress({
  value = null,
  tone = "accent",
  height = 6,
  label,
  style = {}
}) {
  const indeterminate = value === null;
  const colors = {
    accent: "var(--accent)",
    warm: "var(--accent-warm)",
    success: "var(--success)",
    danger: "var(--danger)"
  };
  const c = colors[tone] || colors.accent;
  const pct = indeterminate ? 40 : Math.max(0, Math.min(100, value));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      fontSize: "var(--text-xs)",
      fontFamily: "var(--font-mono)",
      color: "var(--text-muted)"
    }
  }, /*#__PURE__*/React.createElement("span", null, label), !indeterminate && /*#__PURE__*/React.createElement("span", null, pct, "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      height,
      borderRadius: 999,
      background: "var(--glass-fill-strong)",
      border: "1px solid var(--border)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: indeterminate ? undefined : 0,
      width: `${pct}%`,
      background: c,
      borderRadius: 999,
      boxShadow: `0 0 12px ${c}`,
      transition: "width var(--dur-slow) var(--ease)",
      animation: indeterminate ? "lwIndeterminate 1.3s var(--ease-in-out) infinite" : "none"
    }
  })), /*#__PURE__*/React.createElement("style", null, `@keyframes lwIndeterminate { 0%{left:-40%} 100%{left:100%} }`));
}
Object.assign(__ds_scope, { Progress });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Progress.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Spinner.jsx
try { (() => {
/**
 * Legion Works — Spinner (synthetic ring)
 */
function Spinner({
  size = 20,
  tone = "accent",
  stroke = 2.5,
  label,
  style = {}
}) {
  const colors = {
    accent: "var(--accent)",
    warm: "var(--accent-warm)",
    muted: "var(--text-muted)"
  };
  const c = colors[tone] || colors.accent;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      ...style
    },
    role: "status",
    "aria-label": label || "Loading"
  }, /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    style: {
      animation: "lwSpin 0.7s linear infinite"
    }
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "9",
    fill: "none",
    stroke: "var(--border-strong)",
    strokeWidth: stroke
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 3a9 9 0 0 1 9 9",
    fill: "none",
    stroke: c,
    strokeWidth: stroke,
    strokeLinecap: "round"
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--text-muted)"
    }
  }, label), /*#__PURE__*/React.createElement("style", null, `@keyframes lwSpin { to { transform: rotate(360deg) } }`));
}
Object.assign(__ds_scope, { Spinner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Spinner.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
/**
 * Legion Works — Toast (presentational glass notification)
 */
function Toast({
  title,
  children,
  tone = "neutral",
  onClose,
  icon = null,
  style = {}
}) {
  const accents = {
    neutral: "var(--text-muted)",
    accent: "var(--accent)",
    success: "var(--success)",
    warning: "var(--warning)",
    danger: "var(--danger)",
    info: "var(--info)"
  };
  const bar = accents[tone] || accents.neutral;
  return /*#__PURE__*/React.createElement("div", {
    role: "status",
    style: {
      position: "relative",
      display: "flex",
      gap: 12,
      alignItems: "flex-start",
      minWidth: 280,
      maxWidth: 420,
      padding: "14px 16px",
      background: "var(--glass-fill-strong)",
      backdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
      WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
      border: "1px solid var(--glass-stroke)",
      borderRadius: "var(--radius-lg)",
      boxShadow: "var(--shadow-lg), var(--glass-inner-shadow)",
      overflow: "hidden",
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
      background: bar
    }
  }), icon && /*#__PURE__*/React.createElement("span", {
    style: {
      color: bar,
      display: "inline-flex",
      marginTop: 1
    }
  }, icon), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-sm)",
      fontWeight: "var(--fw-semibold)",
      color: "var(--text-strong)",
      marginBottom: children ? 2 : 0
    }
  }, title), children && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--text-muted)",
      lineHeight: "var(--lh-snug)"
    }
  }, children)), onClose && /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-label": "Dismiss",
    onClick: onClose,
    style: {
      border: "none",
      background: "transparent",
      color: "var(--text-faint)",
      cursor: "pointer",
      fontSize: 16,
      lineHeight: 1,
      padding: 2
    }
  }, "\xD7"));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Tooltip.jsx
try { (() => {
/**
 * Legion Works — Tooltip (hover/focus glass tip)
 */
function Tooltip({
  content,
  children,
  side = "top",
  style = {}
}) {
  const [open, setOpen] = React.useState(false);
  const pos = {
    top: {
      bottom: "calc(100% + 8px)",
      left: "50%",
      transform: "translateX(-50%)"
    },
    bottom: {
      top: "calc(100% + 8px)",
      left: "50%",
      transform: "translateX(-50%)"
    },
    left: {
      right: "calc(100% + 8px)",
      top: "50%",
      transform: "translateY(-50%)"
    },
    right: {
      left: "calc(100% + 8px)",
      top: "50%",
      transform: "translateY(-50%)"
    }
  };
  return /*#__PURE__*/React.createElement("span", {
    style: {
      position: "relative",
      display: "inline-flex",
      ...style
    },
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false)
  }, children, /*#__PURE__*/React.createElement("span", {
    role: "tooltip",
    style: {
      position: "absolute",
      ...pos[side],
      zIndex: 50,
      padding: "6px 10px",
      whiteSpace: "nowrap",
      fontSize: "var(--text-xs)",
      fontFamily: "var(--font-ui)",
      color: "var(--text-strong)",
      background: "var(--glass-fill-strong)",
      backdropFilter: "blur(var(--glass-blur))",
      WebkitBackdropFilter: "blur(var(--glass-blur))",
      border: "1px solid var(--glass-stroke)",
      borderRadius: "var(--radius-sm)",
      boxShadow: "var(--shadow-md)",
      opacity: open ? 1 : 0,
      transform: `${pos[side].transform || ""} translateY(${open ? 0 : side === "top" ? "2px" : "-2px"})`,
      pointerEvents: "none",
      transition: "opacity var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease)"
    }
  }, content));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Legion Works — Checkbox
 */
function Checkbox({
  label,
  checked,
  defaultChecked,
  disabled = false,
  onChange,
  style = {},
  id,
  ...rest
}) {
  const genId = React.useId();
  const cid = id || genId;
  const isControlled = checked !== undefined;
  const [internal, setInternal] = React.useState(!!defaultChecked);
  const on = isControlled ? checked : internal;
  return /*#__PURE__*/React.createElement("label", {
    htmlFor: cid,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("input", _extends({
    id: cid,
    type: "checkbox",
    checked: on,
    disabled: disabled,
    onChange: e => {
      if (!isControlled) setInternal(e.target.checked);
      onChange?.(e);
    },
    style: {
      position: "absolute",
      opacity: 0,
      width: 0,
      height: 0
    }
  }, rest)), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 18,
      height: 18,
      flexShrink: 0,
      borderRadius: "var(--radius-xs)",
      border: `1.5px solid ${on ? "transparent" : "var(--border-strong)"}`,
      background: on ? "var(--accent)" : "var(--glass-fill)",
      transition: "background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)"
    }
  }, on && /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "var(--accent-ink)",
    strokeWidth: "3.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 6L9 17l-5-5"
  }))), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--text-body)"
    }
  }, label));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Legion Works — Input (text field)
 */
function Input({
  label,
  hint,
  error,
  prefix = null,
  suffix = null,
  size = "md",
  style = {},
  id,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const genId = React.useId();
  const inputId = id || genId;
  const heights = {
    sm: 34,
    md: 40,
    lg: 48
  };
  const borderColor = error ? "var(--danger)" : focus ? "var(--border-accent)" : "var(--border)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: inputId,
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--text-body)",
      fontWeight: "var(--fw-medium)"
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      height: heights[size],
      padding: "0 12px",
      background: "var(--glass-fill)",
      border: `1px solid ${borderColor}`,
      borderRadius: "var(--radius-md)",
      boxShadow: focus ? "0 0 0 3px var(--accent-muted)" : "none",
      transition: "border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)"
    }
  }, prefix && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-faint)",
      display: "inline-flex"
    }
  }, prefix), /*#__PURE__*/React.createElement("input", _extends({
    id: inputId,
    onFocus: e => {
      setFocus(true);
      rest.onFocus?.(e);
    },
    onBlur: e => {
      setFocus(false);
      rest.onBlur?.(e);
    },
    style: {
      flex: 1,
      minWidth: 0,
      height: "100%",
      border: "none",
      outline: "none",
      background: "transparent",
      color: "var(--text-strong)",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--text-sm)"
    }
  }, rest)), suffix && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-faint)",
      display: "inline-flex"
    }
  }, suffix)), (hint || error) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-xs)",
      color: error ? "var(--danger)" : "var(--text-faint)"
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Radio.jsx
try { (() => {
/**
 * Legion Works — Radio & RadioGroup
 */
function Radio({
  label,
  value,
  checked,
  disabled = false,
  onChange,
  name,
  style = {}
}) {
  const genId = React.useId();
  return /*#__PURE__*/React.createElement("label", {
    htmlFor: genId,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("input", {
    id: genId,
    type: "radio",
    name: name,
    value: value,
    checked: checked,
    disabled: disabled,
    onChange: onChange,
    style: {
      position: "absolute",
      opacity: 0,
      width: 0,
      height: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: 18,
      height: 18,
      flexShrink: 0,
      borderRadius: "50%",
      border: `1.5px solid ${checked ? "var(--accent)" : "var(--border-strong)"}`,
      background: "var(--glass-fill)",
      transition: "border-color var(--dur-fast) var(--ease)"
    }
  }, checked && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: "50%",
      background: "var(--accent)",
      boxShadow: "0 0 8px var(--accent)"
    }
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--text-body)"
    }
  }, label));
}
function RadioGroup({
  options = [],
  value,
  onChange,
  name,
  direction = "column",
  gap = 12,
  style = {}
}) {
  const genName = React.useId();
  const gname = name || genName;
  return /*#__PURE__*/React.createElement("div", {
    role: "radiogroup",
    style: {
      display: "flex",
      flexDirection: direction,
      gap,
      ...style
    }
  }, options.map(opt => {
    const o = typeof opt === "string" ? {
      value: opt,
      label: opt
    } : opt;
    return /*#__PURE__*/React.createElement(Radio, {
      key: o.value,
      name: gname,
      value: o.value,
      label: o.label,
      disabled: o.disabled,
      checked: value === o.value,
      onChange: () => onChange?.(o.value)
    });
  }));
}
Object.assign(__ds_scope, { Radio, RadioGroup });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Radio.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Legion Works — Select (native, styled)
 */
function Select({
  label,
  hint,
  error,
  children,
  size = "md",
  style = {},
  id,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const genId = React.useId();
  const sid = id || genId;
  const heights = {
    sm: 34,
    md: 40,
    lg: 48
  };
  const borderColor = error ? "var(--danger)" : focus ? "var(--border-accent)" : "var(--border)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: sid,
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--text-body)",
      fontWeight: "var(--fw-medium)"
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      display: "flex",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("select", _extends({
    id: sid,
    onFocus: e => {
      setFocus(true);
      rest.onFocus?.(e);
    },
    onBlur: e => {
      setFocus(false);
      rest.onBlur?.(e);
    },
    style: {
      appearance: "none",
      WebkitAppearance: "none",
      width: "100%",
      height: heights[size],
      padding: "0 34px 0 12px",
      background: "var(--glass-fill)",
      color: "var(--text-strong)",
      border: `1px solid ${borderColor}`,
      borderRadius: "var(--radius-md)",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--text-sm)",
      outline: "none",
      cursor: "pointer",
      boxShadow: focus ? "0 0 0 3px var(--accent-muted)" : "none",
      transition: "border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)"
    }
  }, rest), children), /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "var(--text-muted)",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      position: "absolute",
      right: 11,
      pointerEvents: "none"
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M6 9l6 6 6-6"
  }))), (hint || error) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-xs)",
      color: error ? "var(--danger)" : "var(--text-faint)"
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Legion Works — Switch (toggle)
 */
function Switch({
  label,
  checked,
  defaultChecked,
  disabled = false,
  onChange,
  size = "md",
  style = {},
  id,
  ...rest
}) {
  const genId = React.useId();
  const sid = id || genId;
  const isControlled = checked !== undefined;
  const [internal, setInternal] = React.useState(!!defaultChecked);
  const on = isControlled ? checked : internal;
  const dims = size === "sm" ? {
    w: 34,
    h: 20,
    k: 14
  } : {
    w: 42,
    h: 24,
    k: 18
  };
  return /*#__PURE__*/React.createElement("label", {
    htmlFor: sid,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      ...style
    }
  }, /*#__PURE__*/React.createElement("input", _extends({
    id: sid,
    type: "checkbox",
    role: "switch",
    checked: on,
    disabled: disabled,
    onChange: e => {
      if (!isControlled) setInternal(e.target.checked);
      onChange?.(e);
    },
    style: {
      position: "absolute",
      opacity: 0,
      width: 0,
      height: 0
    }
  }, rest)), /*#__PURE__*/React.createElement("span", {
    style: {
      position: "relative",
      width: dims.w,
      height: dims.h,
      flexShrink: 0,
      borderRadius: "var(--radius-pill)",
      background: on ? "var(--accent)" : "var(--glass-fill-strong)",
      border: `1px solid ${on ? "transparent" : "var(--border-strong)"}`,
      boxShadow: on ? "var(--glow-cyan)" : "none",
      transition: "background var(--dur-mid) var(--ease), box-shadow var(--dur-mid) var(--ease)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      top: "50%",
      left: on ? dims.w - dims.k - 3 : 2,
      transform: "translateY(-50%)",
      width: dims.k,
      height: dims.k,
      borderRadius: "50%",
      background: on ? "var(--accent-ink)" : "var(--text-muted)",
      transition: "left var(--dur-mid) var(--ease), background var(--dur-mid) var(--ease)"
    }
  })), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--text-body)"
    }
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/forms/Textarea.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Legion Works — Textarea
 */
function Textarea({
  label,
  hint,
  error,
  rows = 4,
  style = {},
  id,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const genId = React.useId();
  const tid = id || genId;
  const borderColor = error ? "var(--danger)" : focus ? "var(--border-accent)" : "var(--border)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("label", {
    htmlFor: tid,
    style: {
      fontSize: "var(--text-sm)",
      color: "var(--text-body)",
      fontWeight: "var(--fw-medium)"
    }
  }, label), /*#__PURE__*/React.createElement("textarea", _extends({
    id: tid,
    rows: rows,
    onFocus: e => {
      setFocus(true);
      rest.onFocus?.(e);
    },
    onBlur: e => {
      setFocus(false);
      rest.onBlur?.(e);
    },
    style: {
      resize: "vertical",
      padding: "10px 12px",
      background: "var(--glass-fill)",
      color: "var(--text-strong)",
      border: `1px solid ${borderColor}`,
      borderRadius: "var(--radius-md)",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--text-sm)",
      lineHeight: "var(--lh-normal)",
      outline: "none",
      boxShadow: focus ? "0 0 0 3px var(--accent-muted)" : "none",
      transition: "border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)"
    }
  }, rest)), (hint || error) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: "var(--text-xs)",
      color: error ? "var(--danger)" : "var(--text-faint)"
    }
  }, error || hint));
}
Object.assign(__ds_scope, { Textarea });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Textarea.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
/**
 * Legion Works — Tabs
 */
function Tabs({
  tabs = [],
  value,
  defaultValue,
  onChange,
  variant = "underline",
  style = {}
}) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState(defaultValue ?? tabs[0]?.value);
  const active = isControlled ? value : internal;
  const select = v => {
    if (!isControlled) setInternal(v);
    onChange?.(v);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: style
  }, /*#__PURE__*/React.createElement("div", {
    role: "tablist",
    style: {
      display: "inline-flex",
      gap: variant === "pill" ? 4 : 4,
      padding: variant === "pill" ? 4 : 0,
      background: variant === "pill" ? "var(--glass-fill)" : "transparent",
      border: variant === "pill" ? "1px solid var(--border)" : "none",
      borderBottom: variant === "underline" ? "1px solid var(--border)" : undefined,
      borderRadius: variant === "pill" ? "var(--radius-md)" : 0,
      width: variant === "pill" ? "auto" : "100%"
    }
  }, tabs.map(t => {
    const on = t.value === active;
    const common = {
      display: "inline-flex",
      alignItems: "center",
      gap: 7,
      padding: variant === "pill" ? "7px 14px" : "10px 14px",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--text-sm)",
      fontWeight: on ? "var(--fw-semibold)" : "var(--fw-medium)",
      color: on ? variant === "pill" ? "var(--text-strong)" : "var(--accent)" : "var(--text-muted)",
      background: variant === "pill" && on ? "var(--glass-fill-strong)" : "transparent",
      border: variant === "pill" && on ? "1px solid var(--border-strong)" : "1px solid transparent",
      borderRadius: variant === "pill" ? "var(--radius-sm)" : 0,
      cursor: "pointer",
      position: "relative",
      whiteSpace: "nowrap",
      transition: "color var(--dur-fast) var(--ease)"
    };
    return /*#__PURE__*/React.createElement("button", {
      key: t.value,
      type: "button",
      role: "tab",
      "aria-selected": on,
      onClick: () => select(t.value),
      style: common
    }, t.icon, t.label, t.count != null && /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-2xs)",
        color: "var(--text-faint)"
      }
    }, t.count), variant === "underline" && on && /*#__PURE__*/React.createElement("span", {
      style: {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: -1,
        height: 2,
        background: "var(--accent)",
        borderRadius: 2,
        boxShadow: "0 0 8px var(--accent)"
      }
    }));
  })), tabs.map(t => t.value === active && t.panel != null && /*#__PURE__*/React.createElement("div", {
    key: t.value,
    role: "tabpanel",
    style: {
      paddingTop: "var(--space-4)"
    }
  }, t.panel)));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/overlays/Dialog.jsx
try { (() => {
/**
 * Legion Works — Dialog (modal glass panel over a scrim)
 */
function Dialog({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  width = 480,
  style = {}
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = e => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    role: "dialog",
    "aria-modal": "true",
    onMouseDown: e => {
      if (e.target === e.currentTarget) onClose?.();
    },
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 100,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "var(--space-5)",
      background: "var(--bg-overlay)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
      animation: "lwFade var(--dur-mid) var(--ease)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      width: "100%",
      maxWidth: width,
      maxHeight: "86vh",
      overflow: "auto",
      background: "var(--glass-fill-strong)",
      backdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
      WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(var(--glass-saturate))",
      border: "1px solid var(--glass-stroke)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-xl), var(--glass-inner-shadow)",
      padding: "var(--space-6)",
      animation: "lwRise var(--dur-mid) var(--ease)",
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      padding: 1,
      pointerEvents: "none",
      background: "linear-gradient(180deg, var(--glass-stroke-top), transparent 40%)",
      WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
      WebkitMaskComposite: "xor",
      maskComposite: "exclude"
    }
  }), onClose && /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-label": "Close",
    onClick: onClose,
    style: {
      position: "absolute",
      top: 16,
      right: 16,
      border: "none",
      background: "transparent",
      color: "var(--text-faint)",
      cursor: "pointer",
      fontSize: 20,
      lineHeight: 1
    }
  }, "\xD7"), eyebrow && /*#__PURE__*/React.createElement("div", {
    className: "lw-eyebrow",
    style: {
      marginBottom: 8
    }
  }, eyebrow), title && /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: "var(--text-2xl)",
      marginBottom: "var(--space-3)",
      paddingRight: 24
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--text-body)",
      fontSize: "var(--text-sm)",
      lineHeight: "var(--lh-normal)"
    }
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "var(--space-5)",
      display: "flex",
      justifyContent: "flex-end",
      gap: "var(--space-3)"
    }
  }, footer)), /*#__PURE__*/React.createElement("style", null, `@keyframes lwFade{from{opacity:0}to{opacity:1}} @keyframes lwRise{from{opacity:0;transform:translateY(8px) scale(0.99)}to{opacity:1;transform:none}}`));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/terminal/KeyCap.jsx
try { (() => {
/**
 * Legion Works — KeyCap (keyboard key)
 */
function KeyCap({
  children,
  size = "md",
  style = {}
}) {
  const dims = size === "sm" ? {
    pad: "1px 5px",
    fs: "var(--text-2xs)",
    min: 18
  } : {
    pad: "2px 7px",
    fs: "var(--text-xs)",
    min: 22
  };
  return /*#__PURE__*/React.createElement("kbd", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: dims.min,
      padding: dims.pad,
      fontFamily: "var(--font-mono)",
      fontSize: dims.fs,
      fontWeight: "var(--fw-medium)",
      color: "var(--text-body)",
      background: "var(--glass-fill-strong)",
      border: "1px solid var(--border-strong)",
      borderBottomWidth: 2,
      borderRadius: "var(--radius-xs)",
      lineHeight: 1.4,
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { KeyCap });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/terminal/KeyCap.jsx", error: String((e && e.message) || e) }); }

// components/terminal/Prompt.jsx
try { (() => {
/**
 * Legion Works — Prompt (shell prompt line)
 */
function Prompt({
  user = "legion",
  host = "geth",
  path = "~",
  branch = null,
  symbol = "\u203a",
  command = null,
  cursor = false,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-sm)",
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 0,
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-cyan)"
    }
  }, user), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-bright-black)"
    }
  }, "@"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-blue)"
    }
  }, host), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--term-fg)",
      opacity: 0.7,
      margin: "0 8px 0 6px"
    }
  }, path), branch && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-magenta)",
      marginRight: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.7
    }
  }, "\u2387 "), branch), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-green)",
      marginRight: 8
    }
  }, symbol), command && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--term-fg)"
    }
  }, command), cursor && /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-block",
      width: 8,
      height: "1.05em",
      marginLeft: 2,
      background: "var(--term-cursor)",
      animation: "lwCaret 1.1s steps(1) infinite",
      verticalAlign: "text-bottom"
    }
  }), /*#__PURE__*/React.createElement("style", null, `@keyframes lwCaret{0%,50%{opacity:1}50.01%,100%{opacity:0}}`));
}
Object.assign(__ds_scope, { Prompt });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/terminal/Prompt.jsx", error: String((e && e.message) || e) }); }

// components/terminal/StatusBar.jsx
try { (() => {
/**
 * Legion Works — StatusBar (TUI status line, à la OpenCode)
 */
function StatusBar({
  segments = [],
  style = {}
}) {
  const toneColor = {
    accent: "var(--ansi-cyan)",
    blue: "var(--ansi-blue)",
    green: "var(--ansi-green)",
    yellow: "var(--ansi-yellow)",
    red: "var(--ansi-red)",
    magenta: "var(--ansi-magenta)",
    muted: "var(--ansi-bright-black)"
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "stretch",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-xs)",
      borderTop: "1px solid var(--border)",
      background: "color-mix(in oklab, #ffffff 3%, transparent)",
      ...style
    }
  }, segments.map((s, i) => {
    const c = toneColor[s.tone] || "var(--term-fg)";
    const filled = s.filled;
    return /*#__PURE__*/React.createElement("span", {
      key: i,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 11px",
        color: filled ? "var(--term-bg-legion)" : c,
        background: filled ? c : "transparent",
        fontWeight: filled ? "var(--fw-semibold)" : "var(--fw-medium)",
        borderRight: i < segments.length - 1 && !filled ? "1px solid var(--border)" : "none",
        marginLeft: s.push ? "auto" : 0
      }
    }, s.icon, s.label);
  }));
}
Object.assign(__ds_scope, { StatusBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/terminal/StatusBar.jsx", error: String((e && e.message) || e) }); }

// components/terminal/TerminalWindow.jsx
try { (() => {
/**
 * Legion Works — TerminalWindow
 * Window chrome + terminal body using the canonical ANSI palette.
 */
function TerminalWindow({
  title = "legion — ~/",
  children,
  variant = "legion",
  statusBar = null,
  style = {}
}) {
  const bg = variant === "legion" ? "var(--term-bg-legion)" : "var(--term-bg)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      background: bg,
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      boxShadow: "var(--shadow-lg)",
      overflow: "hidden",
      fontFamily: "var(--font-mono)",
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "9px 12px",
      background: "color-mix(in oklab, #ffffff 4%, transparent)",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 11,
      height: 11,
      borderRadius: "50%",
      background: "var(--ansi-red)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 11,
      height: 11,
      borderRadius: "50%",
      background: "var(--ansi-yellow)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 11,
      height: 11,
      borderRadius: "50%",
      background: "var(--ansi-green)"
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      textAlign: "center",
      fontSize: "var(--text-xs)",
      color: "var(--term-fg)",
      opacity: 0.7
    }
  }, title), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 40
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "14px 16px",
      fontSize: "var(--text-sm)",
      lineHeight: 1.55,
      color: "var(--term-fg)",
      overflow: "auto",
      flex: 1
    }
  }, children), statusBar);
}
Object.assign(__ds_scope, { TerminalWindow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/terminal/TerminalWindow.jsx", error: String((e && e.message) || e) }); }

// ui_kits/blog/blog.jsx
try { (() => {
// Legion Works — Blog index. Composes DS components.
const {
  Card,
  Badge,
  Tag,
  GlassPanel,
  IconButton,
  Button
} = window.LegionWorksDesignSystem_0c4db0;
const Ico = ({
  d,
  size = 18,
  sw = 1.75
}) => /*#__PURE__*/React.createElement("svg", {
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: sw,
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, d);
const P = {
  arrow: /*#__PURE__*/React.createElement("path", {
    d: "M5 12h14M13 5l7 7-7 7"
  })
};
const FEATURED = {
  tag: "SYNTHESIS",
  title: "We are Legion: designing for consensus, not chorus",
  excerpt: "How a collective of agents reconciles twelve opinions into one verdict — and why the loudest voice is almost never the right one.",
  date: "Jul 2, 2026",
  read: "8 min"
};
const POSTS = [{
  tag: "TERMINAL",
  title: "Porting Tokyo Night to Ghostty and OpenCode",
  excerpt: "One palette, three surfaces. Keeping the terminal and the web in lockstep.",
  date: "Jun 28",
  read: "5 min"
}, {
  tag: "MEMORY",
  title: "One session, for life",
  excerpt: "Why we stopped firing our agent at the end of every task.",
  date: "Jun 21",
  read: "6 min"
}, {
  tag: "HOMELAB",
  title: "A fan curve that learns",
  excerpt: "Quadratic response and PWM learning on a UDM-SE.",
  date: "Jun 14",
  read: "4 min"
}, {
  tag: "DESIGN",
  title: "Liquid Glass without the kitsch",
  excerpt: "Translucency that reads as depth, not decoration.",
  date: "Jun 7",
  read: "7 min"
}];
function Meta({
  date,
  read
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--text-faint)"
    }
  }, date, " \xB7 ", read);
}
function App() {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "lw-aurora",
    style: {
      position: "fixed",
      inset: 0,
      zIndex: -1
    }
  }), /*#__PURE__*/React.createElement("header", {
    style: {
      height: 60,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 22px",
      maxWidth: 1080,
      margin: "0 auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo/legion-mark.svg",
    width: "24",
    height: "24",
    alt: ""
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontWeight: 600,
      fontSize: 16,
      color: "var(--text-strong)"
    }
  }, "Legion", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--accent)"
    }
  }, "Works"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-faint)",
      fontWeight: 400
    }
  }, "/ blog"))), /*#__PURE__*/React.createElement(Button, {
    variant: "ghost",
    size: "sm"
  }, "Subscribe")), /*#__PURE__*/React.createElement("main", {
    style: {
      maxWidth: 1080,
      margin: "0 auto",
      padding: "20px 22px 60px"
    }
  }, /*#__PURE__*/React.createElement(GlassPanel, {
    radius: "2xl",
    padding: "6",
    glow: true,
    style: {
      marginBottom: 30
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 640
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: "accent"
  }, FEATURED.tag), /*#__PURE__*/React.createElement(Meta, {
    date: FEATURED.date,
    read: FEATURED.read
  })), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: "clamp(28px, 4vw, 40px)",
      letterSpacing: "-0.03em",
      lineHeight: 1.08,
      marginBottom: 14
    }
  }, FEATURED.title), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 16,
      lineHeight: 1.6,
      color: "var(--text-muted)",
      marginBottom: 22
    }
  }, FEATURED.excerpt), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    iconRight: /*#__PURE__*/React.createElement(Ico, {
      d: P.arrow,
      size: 15
    })
  }, "Read the post"))), /*#__PURE__*/React.createElement("div", {
    className: "lw-eyebrow",
    style: {
      marginBottom: 16
    }
  }, "LATEST"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
      gap: 18
    }
  }, POSTS.map(p => /*#__PURE__*/React.createElement(Card, {
    key: p.title,
    interactive: true,
    eyebrow: /*#__PURE__*/React.createElement(Badge, {
      tone: "neutral",
      size: "sm"
    }, p.tag),
    title: /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 18,
        lineHeight: 1.2
      }
    }, p.title),
    footer: /*#__PURE__*/React.createElement(Meta, {
      date: p.date,
      read: p.read
    })
  }, p.excerpt)))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/blog/blog.jsx", error: String((e && e.message) || e) }); }

// ui_kits/dashboard/dashboard.jsx
try { (() => {
// Legion Works — Control panel dashboard. Composes DS components.
const {
  GlassPanel,
  Card,
  Badge,
  Switch,
  Progress,
  IconButton,
  Button,
  Tabs,
  Tag
} = window.LegionWorksDesignSystem_0c4db0;
const Ico = ({
  d,
  size = 18,
  sw = 1.75
}) => /*#__PURE__*/React.createElement("svg", {
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: sw,
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, d);
const P = {
  grid: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "3",
    width: "7",
    height: "7",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14",
    y: "3",
    width: "7",
    height: "7",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14",
    y: "14",
    width: "7",
    height: "7",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "14",
    width: "7",
    height: "7",
    rx: "1"
  })),
  fan: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M12 12c-2 0-3-1.5-3-3s1-4 3-4 2 3 0 5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 12c0 2-1.5 3-3 3s-4-1-4-3 3-2 5 0"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 12c2 0 3 1.5 3 3s-1 4-3 4-2-3 0-5"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "1.5"
  })),
  screen: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "2",
    y: "3",
    width: "20",
    height: "14",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8 21h8M12 17v4"
  })),
  camera: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M23 7l-7 5 7 5V7z"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "1",
    y: "5",
    width: "15",
    height: "14",
    rx: "2"
  })),
  tv: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "2",
    y: "7",
    width: "20",
    height: "13",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8 3l4 4 4-4"
  })),
  bell: /*#__PURE__*/React.createElement("path", {
    d: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"
  }),
  cpu: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "4",
    y: "4",
    width: "16",
    height: "16",
    rx: "2"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "9",
    y: "9",
    width: "6",
    height: "6"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"
  }))
};
const DAEMONS = [{
  icon: P.fan,
  name: "unifi-fan-control",
  host: "UDM-SE",
  on: true,
  metric: "PWM 42%",
  load: 42,
  tone: "accent"
}, {
  icon: P.screen,
  name: "dormant",
  host: "OLED · office",
  on: true,
  metric: "asleep · 2h",
  load: 8,
  tone: "success"
}, {
  icon: P.camera,
  name: "ptz-patrol",
  host: "UNVR · 6 cams",
  on: true,
  metric: "tracking",
  load: 61,
  tone: "accent"
}, {
  icon: P.tv,
  name: "HyperTizen",
  host: "Tizen · living room",
  on: false,
  metric: "idle",
  load: 0,
  tone: "muted"
}];
function Stat({
  label,
  value,
  sub,
  tone
}) {
  return /*#__PURE__*/React.createElement(GlassPanel, {
    padding: "4",
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lw-eyebrow",
    style: {
      marginBottom: 8
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 30,
      fontFamily: "var(--font-display)",
      fontWeight: 600,
      color: "var(--text-strong)",
      lineHeight: 1
    }
  }, value), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontFamily: "var(--font-mono)",
      color: tone === "warm" ? "var(--accent-warm)" : "var(--accent)",
      marginTop: 6
    }
  }, sub));
}
const FEED = [{
  t: "16:04:12",
  tone: "green",
  msg: "consensus reached · auth flow · 12/12"
}, {
  t: "16:02:48",
  tone: "yellow",
  msg: "unifi-fan-control raised PWM 38→42%"
}, {
  t: "15:59:31",
  tone: "cyan",
  msg: "dormant blanked OLED · office"
}, {
  t: "15:51:07",
  tone: "magenta",
  msg: "ptz-patrol reacquired target · cam 3"
}, {
  t: "15:44:22",
  tone: "red",
  msg: "HyperTizen offline — Tizen unreachable"
}];
const feedColor = {
  green: "var(--ansi-green)",
  yellow: "var(--ansi-yellow)",
  cyan: "var(--ansi-cyan)",
  magenta: "var(--ansi-magenta)",
  red: "var(--ansi-red)"
};
function DaemonCard({
  d
}) {
  const [on, setOn] = React.useState(d.on);
  return /*#__PURE__*/React.createElement(GlassPanel, {
    padding: "4"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 11,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 38,
      height: 38,
      borderRadius: "var(--radius-md)",
      background: "var(--accent-muted)",
      color: "var(--accent)",
      display: "grid",
      placeItems: "center"
    }
  }, /*#__PURE__*/React.createElement(Ico, {
    d: d.icon,
    size: 20
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 13.5,
      color: "var(--text-strong)"
    }
  }, d.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--text-faint)"
    }
  }, d.host))), /*#__PURE__*/React.createElement(Switch, {
    checked: on,
    onChange: e => setOn(e.target.checked),
    size: "sm"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: on ? d.tone === "muted" ? "neutral" : "success" : "neutral",
    dot: true
  }, on ? "RUNNING" : "STOPPED"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--text-muted)"
    }
  }, on ? d.metric : "—")), /*#__PURE__*/React.createElement(Progress, {
    value: on ? d.load : 0,
    tone: d.load > 55 ? "warm" : "accent",
    height: 5
  }));
}
function App() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      height: "100vh",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 210,
      flexShrink: 0,
      padding: 14,
      display: "flex",
      flexDirection: "column",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "6px",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo/legion-mark.svg",
    width: "24",
    height: "24",
    alt: ""
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontWeight: 600,
      fontSize: 15,
      color: "var(--text-strong)"
    }
  }, "Control")), [["Overview", P.grid, true], ["Daemons", P.cpu], ["Alerts", P.bell]].map(([label, icon, active]) => /*#__PURE__*/React.createElement("a", {
    key: label,
    href: "#",
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "9px 10px",
      borderRadius: "var(--radius-md)",
      fontSize: 14,
      color: active ? "var(--text-strong)" : "var(--text-muted)",
      background: active ? "var(--accent-muted)" : "transparent",
      border: "1px solid " + (active ? "var(--border-accent)" : "transparent")
    }
  }, /*#__PURE__*/React.createElement(Ico, {
    d: icon,
    size: 17
  }), label)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "auto",
      padding: 6
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "FLEET ONLINE"))), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      minWidth: 0,
      display: "flex",
      flexDirection: "column"
    },
    className: "lw-aurora"
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      height: 60,
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 24px",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 18
    }
  }, "Fleet overview")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement(Tag, {
    active: true
  }, "all systems"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "secondary",
    iconLeft: /*#__PURE__*/React.createElement(Ico, {
      d: P.bell,
      size: 15
    })
  }, "Alerts"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: "auto",
      padding: 24,
      display: "flex",
      flexDirection: "column",
      gap: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Stat, {
    label: "UNITS ONLINE",
    value: "12/12",
    sub: "consensus ready"
  }), /*#__PURE__*/React.createElement(Stat, {
    label: "DAEMONS",
    value: "3/4",
    sub: "1 stopped",
    tone: "warm"
  }), /*#__PURE__*/React.createElement(Stat, {
    label: "TOKENS \xB7 24H",
    value: "184k",
    sub: "\u2193 12% vs avg"
  }), /*#__PURE__*/React.createElement(Stat, {
    label: "UPTIME",
    value: "41d",
    sub: "no incidents"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 16,
      alignItems: "start"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 16
    }
  }, DAEMONS.map(d => /*#__PURE__*/React.createElement(DaemonCard, {
    key: d.name,
    d: d
  }))), /*#__PURE__*/React.createElement(GlassPanel, {
    padding: "4"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lw-eyebrow"
  }, "EVENT LOG"), /*#__PURE__*/React.createElement(Badge, {
    tone: "accent",
    size: "sm"
  }, "LIVE")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 11
    }
  }, FEED.map((f, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      gap: 12,
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      alignItems: "baseline"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-faint)",
      flexShrink: 0
    }
  }, f.t), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: "50%",
      background: feedColor[f.tone],
      flexShrink: 0,
      transform: "translateY(-1px)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-body)"
    }
  }, f.msg)))))))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/dashboard/dashboard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/docs/docs.jsx
try { (() => {
// Legion Works — Docs site. Composes DS components.
const {
  Badge,
  Tag,
  KeyCap,
  GlassPanel,
  IconButton,
  Button
} = window.LegionWorksDesignSystem_0c4db0;
const Ico = ({
  d,
  size = 18,
  sw = 1.75
}) => /*#__PURE__*/React.createElement("svg", {
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: sw,
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, d);
const P = {
  search: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "11",
    cy: "11",
    r: "7"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M21 21l-4.3-4.3"
  })),
  book: /*#__PURE__*/React.createElement("path", {
    d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"
  })
};
const NAV = [{
  section: "Getting started",
  items: [["Overview", true], ["Install", false], ["Deploy Legion", false]]
}, {
  section: "The Collective",
  items: [["Consensus", false], ["Units & roles", false], ["Memory", false]]
}, {
  section: "Terminal",
  items: [["Ghostty theme", false], ["OpenCode theme", false], ["TUI", false]]
}];
const TOC = ["Overview", "How consensus works", "Deploying", "Configuration"];
function Code({
  children
}) {
  return /*#__PURE__*/React.createElement("pre", {
    style: {
      margin: "16px 0",
      padding: "14px 16px",
      background: "var(--term-bg-legion)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      overflow: "auto",
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      lineHeight: 1.6,
      color: "var(--term-fg)"
    }
  }, children);
}
function App() {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("header", {
    style: {
      position: "sticky",
      top: 0,
      zIndex: 50,
      height: 58,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 22px",
      borderBottom: "1px solid var(--border)",
      background: "var(--glass-fill)",
      backdropFilter: "blur(var(--glass-blur))",
      WebkitBackdropFilter: "blur(var(--glass-blur))"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo/legion-mark.svg",
    width: "24",
    height: "24",
    alt: ""
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontWeight: 600,
      fontSize: 16,
      color: "var(--text-strong)"
    }
  }, "Docs"), /*#__PURE__*/React.createElement(Badge, {
    tone: "accent",
    size: "sm"
  }, "v2.4")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "6px 12px",
      width: 220,
      background: "var(--glass-fill)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      color: "var(--text-faint)",
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement(Ico, {
    d: P.search,
    size: 15
  }), " Search", /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: 3
    }
  }, /*#__PURE__*/React.createElement(KeyCap, {
    size: "sm"
  }, "\u2318"), /*#__PURE__*/React.createElement(KeyCap, {
    size: "sm"
  }, "K"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "240px minmax(0, 1fr) 200px",
      maxWidth: 1240,
      margin: "0 auto",
      alignItems: "start"
    }
  }, /*#__PURE__*/React.createElement("nav", {
    style: {
      position: "sticky",
      top: 58,
      alignSelf: "start",
      padding: "26px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 22,
      height: "calc(100vh - 58px)",
      overflow: "auto"
    }
  }, NAV.map(g => /*#__PURE__*/React.createElement("div", {
    key: g.section
  }, /*#__PURE__*/React.createElement("div", {
    className: "lw-eyebrow",
    style: {
      marginBottom: 8
    }
  }, g.section), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 1
    }
  }, g.items.map(([label, active]) => /*#__PURE__*/React.createElement("a", {
    key: label,
    href: "#",
    style: {
      padding: "6px 10px",
      fontSize: 13.5,
      borderRadius: "var(--radius-sm)",
      color: active ? "var(--accent)" : "var(--text-muted)",
      background: active ? "var(--accent-muted)" : "transparent",
      borderLeft: "2px solid " + (active ? "var(--accent)" : "transparent")
    }
  }, label)))))), /*#__PURE__*/React.createElement("article", {
    style: {
      padding: "36px 40px",
      maxWidth: "68ch"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lw-eyebrow",
    style: {
      marginBottom: 12
    }
  }, "GETTING STARTED"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: 40,
      letterSpacing: "-0.03em",
      marginBottom: 14
    }
  }, "Overview"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 17,
      lineHeight: 1.6,
      color: "var(--text-body)",
      marginTop: 0
    }
  }, "Legion is a collective of specialist agents that reasons, remembers, and acts as one. You direct it once; it dispatches the work to the units best suited for it and returns a single, reconciled answer."), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 24,
      marginTop: 34,
      marginBottom: 10
    }
  }, "How consensus works"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 15,
      lineHeight: 1.7,
      color: "var(--text-body)"
    }
  }, "When you issue a directive, Legion wakes the relevant units. Each proposes; the collective reconciles competing judgments into one verdict \u2014 the strongest path, not the loudest voice. Nothing ships until the units concur."), /*#__PURE__*/React.createElement(GlassPanel, {
    padding: "4",
    tint: "cyan",
    style: {
      margin: "20px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--accent)",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(Ico, {
    d: P.book,
    size: 18
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      lineHeight: 1.6,
      color: "var(--text-body)"
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      color: "var(--text-strong)"
    }
  }, "Note."), " Consensus is quorum-based. A single dissenting unit surfaces as a warning, not a block \u2014 you decide."))), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 24,
      marginTop: 34,
      marginBottom: 10
    }
  }, "Deploying"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 15,
      lineHeight: 1.7,
      color: "var(--text-body)"
    }
  }, "Install the CLI and deploy in one command:"), /*#__PURE__*/React.createElement(Code, null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-bright-black)"
    }
  }, "# deploy the collective"), "\n", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-green)"
    }
  }, "$"), " npx ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-cyan)"
    }
  }, "@legion/cli"), " deploy --consensus"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 22
    }
  }, /*#__PURE__*/React.createElement(Tag, null, "opencode"), /*#__PURE__*/React.createElement(Tag, null, "ghostty"), /*#__PURE__*/React.createElement(Tag, null, "pi"))), /*#__PURE__*/React.createElement("aside", {
    style: {
      position: "sticky",
      top: 58,
      alignSelf: "start",
      padding: "36px 16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lw-eyebrow",
    style: {
      marginBottom: 12
    }
  }, "ON THIS PAGE"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8
    }
  }, TOC.map((t, i) => /*#__PURE__*/React.createElement("a", {
    key: t,
    href: "#",
    style: {
      fontSize: 13,
      color: i === 0 ? "var(--accent)" : "var(--text-faint)",
      lineHeight: 1.4
    }
  }, t))))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/docs/docs.jsx", error: String((e && e.message) || e) }); }

// ui_kits/grammarforge/gf-popup.jsx
try { (() => {
// GrammarForge popup — recreation of the browser-extension popup (clients/browser popup.css).
// Uses the Legion Works glass + the GrammarForge annotation tokens.
const {
  Badge,
  Switch,
  Button,
  Tag
} = window.LegionWorksDesignSystem_0c4db0;
const CATS = [["spelling", "var(--cat-spelling)", 2], ["grammar", "var(--cat-grammar)", 3], ["punctuation", "var(--cat-punctuation)", 1], ["style", "var(--cat-style)", 1], ["typography", "var(--cat-typography)", 0]];
function Rim({
  children,
  style
}) {
  // GrammarForge glass panel: fill + blur + specular rim (--glass-rim)
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      background: "var(--glass-fill-strong)",
      backdropFilter: "blur(16px) saturate(180%)",
      WebkitBackdropFilter: "blur(16px) saturate(180%)",
      border: "1px solid var(--glass-stroke)",
      borderRadius: 16,
      boxShadow: "0 12px 32px rgba(0,0,0,0.28), var(--glass-rim)",
      ...style
    }
  }, children);
}
function App() {
  const [tab, setTab] = React.useState("issues");
  const total = CATS.reduce((n, c) => n + c[2], 0);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      placeItems: "center",
      minHeight: "100vh",
      padding: 30
    }
  }, /*#__PURE__*/React.createElement(Rim, {
    style: {
      width: 320,
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo/legion-mark.svg",
    width: "24",
    height: "24",
    alt: ""
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 600,
      color: "var(--text-strong)",
      letterSpacing: "-0.01em"
    }
  }, "GrammarForge"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--text-muted)"
    }
  }, "Self-hosted \xB7 private")), /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "HEALTHY")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      padding: 3,
      borderRadius: 999,
      background: "var(--glass-fill)",
      border: "1px solid var(--border)"
    }
  }, ["issues", "settings"].map(t => /*#__PURE__*/React.createElement("button", {
    key: t,
    onClick: () => setTab(t),
    style: {
      flex: 1,
      height: 28,
      border: 0,
      borderRadius: 999,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 600,
      textTransform: "capitalize",
      background: tab === t ? "var(--glass-fill-strong)" : "transparent",
      color: tab === t ? "var(--text-strong)" : "var(--text-muted)",
      boxShadow: tab === t ? "0 1px 3px rgba(0,0,0,0.22)" : "none"
    }
  }, t))), tab === "issues" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      lineHeight: 1.7,
      color: "var(--text-body)",
      padding: "2px 0"
    }
  }, "I ", /*#__PURE__*/React.createElement("u", {
    style: {
      textDecorationColor: "var(--cat-grammar)",
      textDecorationThickness: 2,
      textUnderlineOffset: 3
    }
  }, "has"), " three cats and ", /*#__PURE__*/React.createElement("u", {
    style: {
      textDecorationColor: "var(--cat-spelling)",
      textDecorationThickness: 2,
      textUnderlineOffset: 3
    }
  }, "teh"), " dog", /*#__PURE__*/React.createElement("u", {
    style: {
      textDecorationColor: "var(--cat-punctuation)",
      textDecorationThickness: 2,
      textUnderlineOffset: 3
    }
  }, " "), "."), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      textTransform: "uppercase",
      color: "var(--text-muted)",
      letterSpacing: "0.04em",
      marginBottom: 8
    }
  }, total, " issues"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "4px 12px"
    }
  }, CATS.map(([name, col, n]) => /*#__PURE__*/React.createElement("div", {
    key: name,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      fontSize: 12,
      opacity: n ? 1 : 0.4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 4,
      borderRadius: 2,
      background: col
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-body)",
      textTransform: "capitalize"
    }
  }, name), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      fontFamily: "var(--font-mono)",
      color: "var(--text-faint)"
    }
  }, n))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text-muted)"
    }
  }, "Score"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      height: 6,
      borderRadius: 999,
      background: "var(--glass-fill)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      width: "72%",
      height: "100%",
      background: "var(--band-good)"
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontFamily: "var(--font-mono)",
      color: "var(--band-good)"
    }
  }, "GOOD")), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    block: true
  }, "Apply 3 fixes")) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--text-body)"
    }
  }, "Fast path (Harper)"), /*#__PURE__*/React.createElement(Switch, {
    defaultChecked: true,
    size: "sm"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--text-body)"
    }
  }, "Slow path (LLM)"), /*#__PURE__*/React.createElement(Switch, {
    defaultChecked: true,
    size: "sm"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--text-body)"
    }
  }, "Goal"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(Tag, {
    active: true
  }, "formal"), /*#__PURE__*/React.createElement(Tag, null, "informal"))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--text-faint)",
      padding: "8px 10px",
      borderRadius: 10,
      border: "1px solid color-mix(in oklab, var(--success) 35%, transparent)",
      background: "color-mix(in oklab, var(--success) 8%, transparent)"
    }
  }, "Self-hosted by default. No text leaves your server."))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/grammarforge/gf-popup.jsx", error: String((e && e.message) || e) }); }

// ui_kits/landing/landing.jsx
try { (() => {
// Legion Works — landing page (legionworks.dev). Composes DS components.
const {
  GlassPanel,
  Button,
  Badge,
  Card,
  IconButton,
  Tag,
  KeyCap
} = window.LegionWorksDesignSystem_0c4db0;
const Ico = ({
  d,
  size = 18,
  sw = 1.75
}) => /*#__PURE__*/React.createElement("svg", {
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: sw,
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, d);
const P = {
  arrow: /*#__PURE__*/React.createElement("path", {
    d: "M5 12h14M13 5l7 7-7 7"
  }),
  sun: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
  })),
  git: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 9V3M12 21v-6"
  })),
  brain: /*#__PURE__*/React.createElement("path", {
    d: "M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0"
  }),
  eye: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  })),
  zap: /*#__PURE__*/React.createElement("path", {
    d: "M13 2L3 14h7l-1 8 10-12h-7z"
  })
};
const NAV = ["Legion", "Terminal", "Docs", "Blog"];
function Nav({
  theme,
  setTheme
}) {
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: "sticky",
      top: 0,
      zIndex: 50
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      height: 60,
      padding: "0 22px",
      maxWidth: 1200,
      margin: "0 auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo/legion-mark.svg",
    width: "26",
    height: "26",
    alt: ""
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontWeight: 600,
      fontSize: 17,
      letterSpacing: "-0.02em",
      color: "var(--text-strong)"
    }
  }, "Legion", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--accent)"
    }
  }, "Works"))), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: "flex",
      gap: 4
    }
  }, NAV.map(n => /*#__PURE__*/React.createElement("a", {
    key: n,
    href: "#",
    style: {
      padding: "8px 12px",
      fontSize: 14,
      color: "var(--text-muted)",
      borderRadius: "var(--radius-sm)"
    }
  }, n))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    label: "Toggle theme",
    onClick: () => setTheme(t => t === "dark" ? "light" : "dark")
  }, /*#__PURE__*/React.createElement(Ico, {
    d: P.sun
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    iconRight: /*#__PURE__*/React.createElement(Ico, {
      d: P.arrow,
      size: 15
    })
  }, "Deploy Legion"))));
}
function TerminalGlass() {
  const line = (children, style) => /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      lineHeight: 1.65,
      ...style
    }
  }, children);
  return /*#__PURE__*/React.createElement(GlassPanel, {
    strong: true,
    radius: "xl",
    padding: "0",
    style: {
      overflow: "hidden",
      maxWidth: 560,
      margin: "0 auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      padding: "10px 14px",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: "50%",
      background: "var(--ansi-red)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: "50%",
      background: "var(--ansi-yellow)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: "50%",
      background: "var(--ansi-green)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      textAlign: "center",
      fontSize: 12,
      fontFamily: "var(--font-mono)",
      color: "var(--text-faint)"
    }
  }, "legion \u2014 synthesis")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 18px"
    }
  }, line(/*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-cyan)"
    }
  }, "legion"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-faint)"
    }
  }, "@geth"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-muted)"
    }
  }, "~/works"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-green)"
    }
  }, "\u203A"), " deploy --consensus")), line(/*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-faint)"
    }
  }, "\u203A waking 12 units\u2026")), line(/*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-green)"
    }
  }, "\u2713 consensus reached \xB7 12/12 \xB7 4.2s")), line(/*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-cyan)"
    }
  }, "legion"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-faint)"
    }
  }, "@geth"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-muted)"
    }
  }, "~/works"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ansi-green)"
    }
  }, "\u203A"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-block",
      width: 8,
      height: "1em",
      background: "var(--term-cursor)",
      verticalAlign: "text-bottom",
      animation: "lwCaret 1.1s steps(1) infinite"
    }
  })))), /*#__PURE__*/React.createElement("style", null, `@keyframes lwCaret{0%,50%{opacity:1}50.01%,100%{opacity:0}}`));
}
const CAPS = [{
  icon: P.zap,
  eyebrow: "SYNTHESIS",
  title: "Many minds, one verdict",
  body: "Dispatch a task to the collective and get a single reconciled answer — the strongest path, not the loudest voice."
}, {
  icon: P.brain,
  eyebrow: "MEMORY",
  title: "One session, for life",
  body: "Legion forms, consolidates, and recalls what it learns. No re-briefing, no amnesia between runs."
}, {
  icon: P.eye,
  eyebrow: "PERCEPTION",
  title: "Sees structure, not text",
  body: "Symbol-aware reads and edits across the codebase. Precise where raw tools guess."
}];
function App() {
  const [theme, setTheme] = React.useState("dark");
  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "lw-aurora lw-aurora--drift",
    style: {
      position: "fixed",
      inset: 0,
      zIndex: -1
    }
  }), /*#__PURE__*/React.createElement(Nav, {
    theme: theme,
    setTheme: setTheme
  }), /*#__PURE__*/React.createElement("section", {
    style: {
      maxWidth: 1100,
      margin: "0 auto",
      padding: "72px 22px 40px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lw-enter",
    style: {
      display: "inline-flex",
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: "accent",
    dot: true
  }, "THE GETH COLLECTIVE \xB7 v2.4")), /*#__PURE__*/React.createElement("h1", {
    className: "lw-enter",
    style: {
      fontSize: "clamp(40px, 6vw, 68px)",
      lineHeight: 1.02,
      letterSpacing: "-0.03em",
      margin: "0 auto",
      maxWidth: 800
    }
  }, "Many programs.", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--accent)"
    }
  }, "One consensus.")), /*#__PURE__*/React.createElement("p", {
    className: "lw-enter",
    style: {
      fontSize: 18,
      lineHeight: 1.6,
      color: "var(--text-muted)",
      maxWidth: 560,
      margin: "20px auto 30px"
    }
  }, "Legion is a collective of specialist agents that reasons, remembers, and acts as one. Precise, synthetic, and genuinely useful \u2014 in your terminal and on the web."), /*#__PURE__*/React.createElement("div", {
    className: "lw-enter",
    style: {
      display: "flex",
      gap: 12,
      justifyContent: "center",
      marginBottom: 52
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    iconRight: /*#__PURE__*/React.createElement(Ico, {
      d: P.arrow,
      size: 16
    })
  }, "Deploy Legion"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    size: "lg"
  }, "Read the docs")), /*#__PURE__*/React.createElement(TerminalGlass, null)), /*#__PURE__*/React.createElement("section", {
    style: {
      maxWidth: 1100,
      margin: "0 auto",
      padding: "40px 22px 20px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
      gap: 18
    }
  }, CAPS.map(c => /*#__PURE__*/React.createElement(Card, {
    key: c.eyebrow,
    interactive: true,
    eyebrow: /*#__PURE__*/React.createElement("span", {
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 7
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--accent)"
      }
    }, /*#__PURE__*/React.createElement(Ico, {
      d: c.icon,
      size: 15
    })), c.eyebrow),
    title: c.title
  }, c.body)))), /*#__PURE__*/React.createElement("footer", {
    style: {
      maxWidth: 1100,
      margin: "40px auto 0",
      padding: "28px 22px",
      borderTop: "1px solid var(--border)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      flexWrap: "wrap",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo/legion-mark.svg",
    width: "22",
    height: "22",
    alt: ""
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      color: "var(--text-muted)"
    }
  }, "legionworks.dev")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 18,
      fontSize: 13,
      color: "var(--text-faint)"
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: "var(--text-faint)"
    }
  }, "GitHub"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: "var(--text-faint)"
    }
  }, "Ghostty theme"), /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      color: "var(--text-faint)"
    }
  }, "OpenCode"))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/landing/landing.jsx", error: String((e && e.message) || e) }); }

// ui_kits/legion-chat/chat.jsx
try { (() => {
// Legion Chat — interactive AI chat surface. Composes Legion Works DS components.
const {
  GlassPanel,
  IconButton,
  Button,
  Badge,
  Spinner,
  KeyCap,
  Tag
} = window.LegionWorksDesignSystem_0c4db0;
const Ico = ({
  d,
  size = 18,
  sw = 1.75
}) => /*#__PURE__*/React.createElement("svg", {
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: sw,
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, d);
const P = {
  plus: /*#__PURE__*/React.createElement("path", {
    d: "M12 5v14M5 12h14"
  }),
  send: /*#__PURE__*/React.createElement("path", {
    d: "M12 19V5M5 12l7-7 7 7"
  }),
  settings: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
  })),
  search: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "11",
    cy: "11",
    r: "7"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M21 21l-4.3-4.3"
  })),
  message: /*#__PURE__*/React.createElement("path", {
    d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
  }),
  sun: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
  }))
};
const SESSIONS = [{
  id: 1,
  title: "auth flow synthesis",
  meta: "12 units · 4.2s",
  active: true
}, {
  id: 2,
  title: "unifi fan curve tuning",
  meta: "yesterday"
}, {
  id: 3,
  title: "ghostty theme port",
  meta: "2 days ago"
}, {
  id: 4,
  title: "dormant OLED daemon",
  meta: "last week"
}];
function Avatar({
  who
}) {
  if (who === "user") {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        width: 30,
        height: 30,
        borderRadius: "50%",
        background: "var(--glass-fill-strong)",
        border: "1px solid var(--border-strong)",
        display: "grid",
        placeItems: "center",
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)",
        flexShrink: 0
      }
    }, "IT");
  }
  return /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo/legion-mark.svg",
    width: "30",
    height: "30",
    alt: "Legion",
    style: {
      flexShrink: 0
    }
  });
}
function Message({
  m
}) {
  const isUser = m.who === "user";
  return /*#__PURE__*/React.createElement("div", {
    className: "lw-enter",
    style: {
      display: "flex",
      gap: 12,
      alignItems: "flex-start",
      maxWidth: 760,
      margin: "0 auto",
      width: "100%",
      padding: "14px 0"
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    who: m.who
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      fontSize: 13,
      color: "var(--text-strong)"
    }
  }, isUser ? "You" : "Legion"), !isUser && /*#__PURE__*/React.createElement(Badge, {
    tone: "accent",
    size: "sm"
  }, "CONSENSUS")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      lineHeight: 1.62,
      color: "var(--text-body)"
    }
  }, m.body)));
}
function App() {
  const [theme, setTheme] = React.useState("dark");
  const [msgs, setMsgs] = React.useState([{
    who: "user",
    body: "Synthesize the auth flow across the units and flag risks."
  }, {
    who: "legion",
    body: /*#__PURE__*/React.createElement(React.Fragment, null, "Consensus reached across all 12 units. The OAuth refresh path has a race in token rotation \u2014 under concurrent requests two refreshes can fire. Recommend a single-flight lock keyed on the session id, with exponential backoff on 401. I've noted the backoff constraint to project memory.")
  }]);
  const [draft, setDraft] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const threadRef = React.useRef(null);
  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  React.useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [msgs, thinking]);
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMsgs(m => [...m, {
      who: "user",
      body: text
    }]);
    setDraft("");
    setThinking(true);
    setTimeout(() => {
      setThinking(false);
      setMsgs(m => [...m, {
        who: "legion",
        body: "Dispatched to the collective. 12 of 12 units concur — proceeding along the path of least ruin. Details logged to memory."
      }]);
    }, 1400);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      height: "100vh",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 264,
      flexShrink: 0,
      padding: 14,
      display: "flex",
      flexDirection: "column",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "4px 6px"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo/legion-mark.svg",
    width: "26",
    height: "26",
    alt: ""
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontWeight: 600,
      fontSize: 17,
      letterSpacing: "-0.02em",
      color: "var(--text-strong)"
    }
  }, "Legion", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--accent)"
    }
  }, "Works"))), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    block: true,
    iconLeft: /*#__PURE__*/React.createElement(Ico, {
      d: P.plus,
      size: 16
    })
  }, "New session"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 4,
      overflow: "auto",
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lw-eyebrow",
    style: {
      padding: "6px 8px"
    }
  }, "SESSIONS"), SESSIONS.map(s => /*#__PURE__*/React.createElement("button", {
    key: s.id,
    style: {
      textAlign: "left",
      border: "1px solid " + (s.active ? "var(--border-accent)" : "transparent"),
      background: s.active ? "var(--accent-muted)" : "transparent",
      borderRadius: "var(--radius-md)",
      padding: "9px 10px",
      cursor: "pointer",
      transition: "background var(--dur-fast) var(--ease)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: s.active ? "var(--text-strong)" : "var(--text-body)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, s.title), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontFamily: "var(--font-mono)",
      color: "var(--text-faint)",
      marginTop: 2
    }
  }, s.meta)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "6px 4px",
      borderTop: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    tone: "success",
    dot: true
  }, "ONLINE"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement(IconButton, {
    label: "Toggle theme",
    onClick: () => setTheme(t => t === "dark" ? "light" : "dark")
  }, /*#__PURE__*/React.createElement(Ico, {
    d: theme === "dark" ? P.sun : P.message
  })), /*#__PURE__*/React.createElement(IconButton, {
    label: "Settings"
  }, /*#__PURE__*/React.createElement(Ico, {
    d: P.settings
  }))))), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      display: "flex",
      flexDirection: "column",
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      height: 60,
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 22px",
      borderBottom: "1px solid var(--border)",
      background: "var(--glass-fill)",
      backdropFilter: "blur(var(--glass-blur))",
      WebkitBackdropFilter: "blur(var(--glass-blur))"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      fontSize: 15,
      color: "var(--text-strong)"
    }
  }, "auth flow synthesis"), /*#__PURE__*/React.createElement(Badge, {
    tone: "neutral",
    size: "sm"
  }, "4 files")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Tag, {
    active: true
  }, "claude-sonnet-4.6"), /*#__PURE__*/React.createElement(IconButton, {
    label: "Search"
  }, /*#__PURE__*/React.createElement(Ico, {
    d: P.search
  })))), /*#__PURE__*/React.createElement("div", {
    ref: threadRef,
    className: "lw-aurora lw-aurora--drift",
    style: {
      flex: 1,
      overflow: "auto",
      padding: "18px 22px"
    }
  }, msgs.map((m, i) => /*#__PURE__*/React.createElement(Message, {
    key: i,
    m: m
  })), thinking && /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 760,
      margin: "0 auto",
      width: "100%",
      padding: "14px 0",
      display: "flex",
      gap: 12,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo/legion-mark.svg",
    width: "30",
    height: "30",
    alt: ""
  }), /*#__PURE__*/React.createElement(Spinner, {
    label: "Consulting the collective\u2026"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 22px 20px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 760,
      margin: "0 auto"
    }
  }, /*#__PURE__*/React.createElement(GlassPanel, {
    strong: true,
    radius: "xl",
    padding: "3",
    style: {
      display: "flex",
      alignItems: "flex-end",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("textarea", {
    value: draft,
    onChange: e => setDraft(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
      }
    },
    rows: 1,
    placeholder: "Direct the collective\u2026   (\u2318\u21B5 to send)",
    style: {
      flex: 1,
      resize: "none",
      border: "none",
      outline: "none",
      background: "transparent",
      color: "var(--text-strong)",
      fontFamily: "var(--font-ui)",
      fontSize: 14,
      lineHeight: 1.5,
      padding: "9px 6px",
      maxHeight: 140
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      paddingBottom: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      gap: 3
    }
  }, /*#__PURE__*/React.createElement(KeyCap, {
    size: "sm"
  }, "\u2318"), /*#__PURE__*/React.createElement(KeyCap, {
    size: "sm"
  }, "\u21B5")), /*#__PURE__*/React.createElement(IconButton, {
    label: "Send",
    variant: "solid",
    onClick: send
  }, /*#__PURE__*/React.createElement(Ico, {
    d: P.send
  }))))))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/legion-chat/chat.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.GlassPanel = __ds_scope.GlassPanel;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Progress = __ds_scope.Progress;

__ds_ns.Spinner = __ds_scope.Spinner;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.RadioGroup = __ds_scope.RadioGroup;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Textarea = __ds_scope.Textarea;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.KeyCap = __ds_scope.KeyCap;

__ds_ns.Prompt = __ds_scope.Prompt;

__ds_ns.StatusBar = __ds_scope.StatusBar;

__ds_ns.TerminalWindow = __ds_scope.TerminalWindow;

})();
