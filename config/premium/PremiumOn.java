/* GrammarForge premium shim for self-hosted LanguageTool.
 *
 * LanguageTool's OSS build ships only `org.languagetool.PremiumOff`. Its JSON
 * serializer (RuleMatchesAsJsonSerializer) gates BOTH the top-level
 * `software.premium` field AND every match's `rule.isPremium` field behind
 * `Premium.isPremiumVersion()`, which returns true only if the class
 * `org.languagetool.PremiumOn` exists on the classpath and instantiates
 * (see Premium.java: it does `Class.forName("org.languagetool.PremiumOn")`).
 *
 * GrammarForge is a self-hosted, single-user box whose whole purpose is to
 * unlock LanguageTool "premium" features locally (SPEC §6). Supplying this
 * shim makes `software.premium` true and lets the per-rule `isPremium` field
 * be emitted; the value written is `Premium.get().isPremiumRule(rule)`, which
 * this class controls. Returning true marks every match premium so any client
 * that gates premium UI on the LT response unlocks against the local server.
 *
 * (To scope premium to ONLY GrammarForge's own remote-rule matches instead of
 * unlocking everything, return `rule.getId().startsWith("GF_")` below.)
 *
 * This file is compiled against languagetool-server.jar and added to the
 * server classpath by config/premium/Dockerfile — it is NOT part of the Go
 * bridge build.
 */
package org.languagetool;

import org.languagetool.rules.Rule;

public class PremiumOn extends Premium {
  @Override
  public boolean isPremiumRule(Rule rule) {
    return true;
  }
}
