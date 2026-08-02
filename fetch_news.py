#!/usr/bin/env python3
# Fetches recent whisky-related news from Google News RSS and writes a
# compact JSON feed to whisky-news.json for the ScottishDelight.com
# homepage widget to consume.
#
# Standard library only, no external dependencies, so the GitHub Actions
# workflow needs no pip install step.

import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote

# Search terms. Kept broad for now; can be split into per-region feeds later.
QUERIES = ["whisky", "whiskey", "bourbon", "scotch whisky"]

# Only keep items published within this window.
MAX_AGE_HOURS = 48

# Max items written to the output feed.
MAX_ITEMS = 8

OUTPUT_FILE = "whisky-news.json"

USER_AGENT = "Mozilla/5.0 (compatible; ScottishDelightNewsBot/1.0)"

# Titles containing any of these (case-insensitive) are dropped as known
# false positives, e.g. "Bourbon virus" is a real tick-borne illness with
# no connection to bourbon whiskey. Loaded from exclude_patterns.json so
# the weekly review job can update it without editing this file.
EXCLUDE_PATTERNS_FILE = "exclude_patterns.json"

DEFAULT_EXCLUDE_PATTERNS = [
    "bourbon virus",
    "tick-borne",
    "testosterone",
]


def load_exclude_patterns():
    try:
        with open(EXCLUDE_PATTERNS_FILE, "r", encoding="utf-8") as f:
            patterns = json.load(f)
        if isinstance(patterns, list) and all(isinstance(p, str) for p in patterns):
            return patterns
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return DEFAULT_EXCLUDE_PATTERNS


def fetch_feed(query):
    url = "https://news.google.com/rss/search?q=" + quote(query) + "&hl=en-US&gl=US&ceid=US:en"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def clean_title(raw_title, source_name):
    # Google News titles are usually "Headline - Source". Strip the
    # trailing source suffix since we display source separately.
    if source_name:
        suffix = " - " + source_name
        if raw_title.endswith(suffix):
            return raw_title[: -len(suffix)].strip()
    # Fallback: strip any trailing " - Something" pattern
    return re.sub(r"\s+-\s+[^-]+$", "", raw_title).strip()


def parse_feed(xml_bytes, exclude_patterns):
    items = []
    root = ET.fromstring(xml_bytes)
    for item in root.findall("./channel/item"):
        title_el = item.find("title")
        link_el = item.find("link")
        pubdate_el = item.find("pubDate")
        source_el = item.find("source")

        if title_el is None or link_el is None or pubdate_el is None:
            continue

        raw_title = (title_el.text or "").strip()
        link = (link_el.text or "").strip()
        source_name = (source_el.text or "").strip() if source_el is not None else ""

        try:
            published = parsedate_to_datetime(pubdate_el.text)
            if published.tzinfo is None:
                published = published.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue

        title = clean_title(raw_title, source_name)
        if not title or not link:
            continue
        if any(pattern in title.lower() for pattern in exclude_patterns):
            continue

        items.append({
            "title": title,
            "link": link,
            "source": source_name or "Unknown source",
            "published": published.isoformat(),
        })
    return items


def dedupe(items):
    seen = set()
    unique = []
    for item in items:
        key = item["title"].lower().strip()
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def main():
    exclude_patterns = load_exclude_patterns()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=MAX_AGE_HOURS)
    all_items = []

    for query in QUERIES:
        try:
            xml_bytes = fetch_feed(query)
            all_items.extend(parse_feed(xml_bytes, exclude_patterns))
        except Exception as exc:
            print("Warning: failed to fetch/parse query " + repr(query) + ": " + str(exc), file=sys.stderr)

    recent = [item for item in all_items if datetime.fromisoformat(item["published"]) >= cutoff]

    recent.sort(key=lambda i: i["published"], reverse=True)
    recent = dedupe(recent)[:MAX_ITEMS]

    feed = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "items": recent,
    }

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(feed, f, ensure_ascii=False, indent=2)

    print("Wrote " + str(len(recent)) + " items to " + OUTPUT_FILE)


if __name__ == "__main__":
    main()
