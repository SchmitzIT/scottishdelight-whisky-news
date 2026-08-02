#!/usr/bin/env python3
# Weekly self-review job. Fetches the same RSS queries as fetch_news.py,
# but looks at ALL items (not just the recent/top ones) to catch titles
# that match a search term but are clearly off-topic. When a title
# contains a "junk indicator" word with no whisky-context word nearby,
# the matched indicator is added to exclude_patterns.json so future
# hourly fetches drop it automatically. No human review gate by design;
# every change is a plain git commit so it stays fully auditable.

import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import quote

QUERIES = ["whisky", "whiskey", "bourbon", "scotch whisky"]
EXCLUDE_PATTERNS_FILE = "exclude_patterns.json"
USER_AGENT = "Mozilla/5.0 (compatible; ScottishDelightNewsBot/1.0)"

# Broad terms that tend to signal an off-topic hit sharing a keyword with
# whisky/bourbon/scotch (illnesses, sports, finance, politics, etc.).
# Kept general on purpose; the whisky-context check below is what keeps
# this from over-triggering on legitimate stories.
JUNK_INDICATOR_WORDS = [
    "virus", "outbreak", "disease", "tick-borne", "testosterone",
    "diagnosis", "symptom", "vaccine", "cancer",
    "touchdown", "quarterback", "playoff", "scoreline", "matchday",
    "stock price", "earnings call", "quarterly report", "shares fell",
    "election", "senator", "parliament", "referendum",
    "county fair livestock", "horse racing results",
]

# If any of these appear in the title, treat it as genuinely whisky-related
# even if a junk indicator word is also present, and don't flag it.
WHISKY_CONTEXT_WORDS = [
    "distillery", "distilled", "single malt", "cask", "dram", "proof",
    "mash bill", "pot still", "bottling", "tasting notes", "spirits award",
    "rye whiskey", "bourbon whiskey", "scotch whisky", "cooperage",
    "blended whisky", "master distiller", "warehouse no",
]


def fetch_feed(query):
    url = "https://news.google.com/rss/search?q=" + quote(query) + "&hl=en-US&gl=US&ceid=US:en"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def all_titles(xml_bytes):
    titles = []
    root = ET.fromstring(xml_bytes)
    for item in root.findall("./channel/item"):
        title_el = item.find("title")
        if title_el is not None and title_el.text:
            titles.append(title_el.text.strip())
    return titles


def load_patterns():
    try:
        with open(EXCLUDE_PATTERNS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_patterns(patterns):
    with open(EXCLUDE_PATTERNS_FILE, "w", encoding="utf-8") as f:
        json.dump(patterns, f, ensure_ascii=False, indent=2)
        f.write("\n")


def find_new_patterns(titles, existing_patterns):
    existing_lower = [p.lower() for p in existing_patterns]
    new_patterns = []

    for title in titles:
        lowered = title.lower()

        # Skip anything already covered.
        if any(p in lowered for p in existing_lower):
            continue

        # Skip anything with genuine whisky context.
        if any(ctx in lowered for ctx in WHISKY_CONTEXT_WORDS):
            continue

        for indicator in JUNK_INDICATOR_WORDS:
            if indicator in lowered and indicator not in existing_lower and indicator not in new_patterns:
                new_patterns.append(indicator)
                print(f"Flagged new exclusion candidate '{indicator}' from title: {title}")

    return new_patterns


def main():
    all_titles_seen = []
    for query in QUERIES:
        try:
            xml_bytes = fetch_feed(query)
            all_titles_seen.extend(all_titles(xml_bytes))
        except Exception as exc:
            print(f"Warning: failed to fetch query {query!r}: {exc}", file=sys.stderr)

    existing = load_patterns()
    new_patterns = find_new_patterns(all_titles_seen, existing)

    if not new_patterns:
        print("No new false-positive patterns found this run.")
        return

    updated = existing + new_patterns
    save_patterns(updated)
    print(f"Added {len(new_patterns)} new pattern(s): {new_patterns}")


if __name__ == "__main__":
    main()
