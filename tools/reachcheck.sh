#!/usr/bin/env bash
# tools/reachcheck.sh — can an assistant actually read zoost.it?
#
# The whole verifiability posture assumes it can. llms.txt, the evidence chain, "read the source and
# check for yourself" — every one of those is worthless if the fetch returns 403 before any of it is
# seen. And that failure is silent from our side: the site looks fine in a browser, and an agent
# reports that it found nothing.
#
# It has already happened once. A review of this project concluded "still to be validated" while
# stating it had not managed to open the site — so its verdict measured its own reach, not the
# product. Whether that was this block or its own tooling was never established, but the block is
# real: Cloudflare's default managed rules 403 a couple of legacy scripted-client signatures.
#
# NOT part of tests/run.sh, on purpose: it needs the network and the live site, and a suite that
# fails because DNS is slow is a suite people stop believing. Run it after any change to the
# Cloudflare configuration, and before assuming an agent could have read what it was given.
set -uo pipefail
SITE="${1:-https://zoost.it}"

echo "── $SITE ──"
fail=0

probe() {
  local label="$1" ua="$2" url="$3"
  local code
  code=$(curl -s -o /tmp/reach.$$ -w '%{http_code}' --max-time 15 ${ua:+-A "$ua"} "$url")
  local ok="ok"
  if [ "$code" != "200" ] || ! grep -qi 'zoost' /tmp/reach.$$ 2>/dev/null; then ok="UNREACHABLE"; fail=1; fi
  printf '  %-34s %-4s %s\n' "$label" "$code" "$ok"
  rm -f /tmp/reach.$$
}

# The agents the strategy actually depends on.
probe "ClaudeBot"      "ClaudeBot/1.0 (+claudebot@anthropic.com)"                         "$SITE/"
probe "GPTBot"         "GPTBot/1.0 (+https://openai.com/gptbot)"                          "$SITE/"
probe "PerplexityBot"  "PerplexityBot/1.0"                                                "$SITE/"
probe "bingbot"        "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" "$SITE/"
probe "Googlebot"      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" "$SITE/"

# Ordinary scripted clients, which is what a naive fetcher sends.
probe "python-requests" "python-requests/2.31.0"  "$SITE/"
probe "node-fetch"      "node-fetch/3.0"          "$SITE/"
probe "curl"            "curl/8.0"                "$SITE/"
probe "no user agent"   ""                        "$SITE/"

# The map itself, which is the first thing an assessment should reach.
probe "llms.txt"        "ClaudeBot/1.0"           "$SITE/llms.txt"

# Reaching the site and being *allowed* to are two different questions, and this file only ever asked
# the first. A well-behaved crawler fetches robots.txt and obeys it, so a 200 here proves the door
# opens while the sign on it may say keep out — which is exactly what was found: Cloudflare's managed
# robots.txt content was injecting `Disallow: /` for ClaudeBot, GPTBot, CCBot, Google-Extended and
# four others, above our own `Allow: /`. Every probe above still passed. The block is a dashboard
# setting, not a file in this repository, which is why nothing here could have caught it by reading
# the repo.
echo
echo "── robots.txt ──"
robots=$(curl -s --max-time 15 "$SITE/robots.txt")
for ua in ClaudeBot GPTBot PerplexityBot CCBot Google-Extended Applebot-Extended Amazonbot bingbot Googlebot; do
  if printf '%s' "$robots" | awk -v ua="$ua" '
      BEGIN{IGNORECASE=1; hit=0}
      /^[Uu]ser-agent:/ { cur = ($2 == ua) }
      cur && /^[Dd]isallow:[[:space:]]*\/[[:space:]]*$/ { hit=1 }
      END{ exit !hit }'; then
    printf '  %-22s %s\n' "$ua" "DISALLOWED by robots.txt"
    fail=1
  else
    printf '  %-22s %s\n' "$ua" "allowed"
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "Every probe reached the site — but note what that does and does not prove. These are ordinary"
  echo "requests carrying a bot's user agent from an ordinary address. Cloudflare identifies a verified"
  echo "crawler by its network, not by the string it sends, so a rule that blocks ClaudeBot will not"
  echo "block this probe and a 200 here says nothing about it. The bot toggles in AI Crawl Control are"
  echo "the authority for that; the robots.txt section below is the only part of it this can read."
  echo
  echo "Known exceptions, blocked by Cloudflare's default managed rules"
  echo "and deliberately not probed above: Python-urllib and libwww-perl, both legacy scanner"
  echo "signatures. If an assistant reports it could not read the site, ask which client it used."
else
  echo "At least one probe could not read the site, or is told not to. Everything the project claims"
  echo "about being checkable depends on this, and the failure is invisible from a browser."
  echo "A robots.txt disallow is a Cloudflare setting, not a file here: AI Crawl Control / managed"
  echo "robots.txt content in the dashboard for zoost.it."
fi
exit "$fail"
