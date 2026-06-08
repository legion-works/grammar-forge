# GrammarForge custom LanguageTool image: erikvl87/languagetool + the PremiumOn
# classpath shim that unlocks /v2/check premium signalling on the OSS build.
#
# Why: OSS LanguageTool's RuleMatchesAsJsonSerializer only emits
# `software.premium` and per-rule `isPremium` when `Premium.isPremiumVersion()`
# is true, which requires `org.languagetool.PremiumOn` on the classpath (it
# does Class.forName on that name). The OSS jar ships only PremiumOff. This
# image compiles a PremiumOn shim and adds it to the server classpath.
#
# Verified facts about erikvl87/languagetool:6.7 (your-server, 2026-06-08):
#   - launch: `java -cp languagetool-server.jar org.languagetool.server.HTTPServer ...`
#     from CWD /LanguageTool (a SINGLE literal -cp entry, NO glob, NO -jar).
#   - JRE only (no javac) → compile the shim in a separate JDK build stage.
#   - /LanguageTool/libs/ holds the deps but is NOT on the runtime classpath,
#     so we ALSO patch start.sh's -cp to include libs/* (which carries our jar).
#
# Build (from repo root):
#   docker build -t grammarforge-languagetool:test \
#     --build-arg LT_IMAGE=erikvl87/languagetool:6.7 -f config/premium/Dockerfile config/premium
#
# To scope premium to only GF_* rules, edit PremiumOn.java (see its comment).

ARG LT_IMAGE=erikvl87/languagetool:6.7

# --- build stage: compile PremiumOn against the LT server jar -----------------
FROM eclipse-temurin:17-jdk AS build
# Pull the LT server jar from the target image to compile against its Premium API.
COPY --from=erikvl87/languagetool:6.7 /LanguageTool/languagetool-server.jar /build/languagetool-server.jar
COPY PremiumOn.java /build/PremiumOn.java
WORKDIR /build
RUN javac -cp languagetool-server.jar -d out PremiumOn.java \
  && (cd out && jar -cf /premium-on.jar .) \
  && jar -tf /premium-on.jar | grep -q 'org/languagetool/PremiumOn.class'

# --- runtime stage: LT image + the shim jar on the classpath ------------------
FROM ${LT_IMAGE}
COPY --from=build /premium-on.jar /LanguageTool/libs/premium-on.jar
# The stock start.sh uses `-cp languagetool-server.jar` only. Extend the
# classpath to also include /LanguageTool/libs/* so PremiumOn resolves. Idempotent
# (only rewrites the exact stock token).
RUN sed -i 's|-cp languagetool-server.jar|-cp languagetool-server.jar:/LanguageTool/libs/*|' /LanguageTool/start.sh \
  && grep -q 'languagetool-server.jar:/LanguageTool/libs/\*' /LanguageTool/start.sh
