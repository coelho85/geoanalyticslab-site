#!/usr/bin/env bash
# Tell IndexNow search engines (Bing, Yandex, Seznam, Naver...) that pages changed.
#
#   .github/scripts/indexnow.sh                 submit every URL in sitemap.xml
#   .github/scripts/indexnow.sh URL [URL...]    submit only these URLs
#
# The key file /<KEY>.txt must be live on the site before submitting.
set -euo pipefail

HOST="geoanalyticslab.com"
KEY="539aba06107239612c563420f1935ddd"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "$#" -gt 0 ]; then
  urls=("$@")
else
  urls=()
  while IFS= read -r u; do urls+=("$u"); done < <(grep -o '<loc>[^<]*</loc>' "$ROOT/sitemap.xml" | sed 's/<[^>]*>//g')
fi

if [ "${#urls[@]}" -eq 0 ]; then
  echo "IndexNow: nothing to submit."
  exit 0
fi

json_urls=$(printf '"%s",' "${urls[@]}")
payload=$(printf '{"host":"%s","key":"%s","keyLocation":"https://%s/%s.txt","urlList":[%s]}' \
  "$HOST" "$KEY" "$HOST" "$KEY" "${json_urls%,}")

printf 'IndexNow: submitting %d URL(s)\n' "${#urls[@]}"
printf '  %s\n' "${urls[@]}"

code=$(curl -sS -o /dev/stderr -w '%{http_code}' -X POST "https://api.indexnow.org/indexnow" \
  -H 'Content-Type: application/json; charset=utf-8' --data "$payload")
echo "IndexNow: HTTP $code"
# 200 = accepted, 202 = accepted (key check pending)
[ "$code" = "200" ] || [ "$code" = "202" ]
