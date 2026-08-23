/**
 * ScottishDelight.com distillery map widget -- shared module.
 *
 * One file, loaded by every map page (region, sub-region, or Scotland-wide).
 * A page's Elementor HTML widget is just a tiny shell: an empty container
 * div + one call to SDDistilleryMap.init(containerId, config). All the
 * actual logic -- fetching, filtering, clustering, rendering -- lives here,
 * so a future fix or feature is one file, not N pasted copies.
 *
 * Requires (loaded by the page, not by this file):
 *   - Leaflet core (enqueued site-wide via functions.php)
 *   - Leaflet.markercluster CSS + JS
 *   - map-widget.css (this module's stylesheet)
 *
 * config shape:
 *   {
 *     title: "Lowland Distilleries",
 *     subtitle: "ScottishDelight.com — regional distillery map",
 *     mode: "region" | "subregion" | "all-scotland",
 *     // mode "region":    filters on tax_distillery_region by regionSlug
 *     // mode "subregion": filters on tax_distillery_sub_region by regionSlug
 *     // mode "all-scotland": fetches every region except excludedRegionNames,
 *     //                      adds a Region filter dropdown automatically
 *     regionSlug: "lowland",       // required for "region"/"subregion" modes
 *     excludedRegionNames: ["cumbria", "the cotswolds", "suffolk"],  // "all-scotland" only
 *     initialView: [55.7, -3.6, 8],   // [lat, lng, zoom]
 *     fitBounds: { padding: [40, 40], maxZoom: 16 }  // maxZoom optional
 *   }
 */
(function (global) {
  "use strict";

  var WP_BASE_URL = global.location.origin; // same-origin, no CORS concerns -- this only ever runs on scottishdelight.com
  var REGION_TAXONOMY = "tax_distillery_region";
  var SUBREGION_TAXONOMY = "tax_distillery_sub_region";

  var STATUS_COLORS = {
    "active": "#2e7d32",
    "in planning": "#c9a227",
    "under construction": "#c9a227"
  };
  var STATUS_DEFAULT_COLOR = "#8a8378";

  // ------------------------------------------------------------------ //
  // Small pure helpers
  // ------------------------------------------------------------------ //

  function decodeHtmlEntities(str) {
    var el = document.createElement("textarea");
    el.innerHTML = str;
    return el.value;
  }

  function shortDistilleryName(fullTitle) {
    // Title conventions on this site (in order of how common/current they are):
    //   1. "{Name} Distillery: {subtitle} | Scottish Delight"
    //   1b. "{Name} Distillery Guide: {subtitle} | Scottish Delight"
    //   1c. "{Name} Whisky: {subtitle} | Scottish Delight"
    //   2. Any other "{Name}: {subtitle} | Scottish Delight" (no Distillery/Whisky marker word)
    //   3. OLD STYLE, roughly half the site as of Aug 2026, being migrated over time:
    //      "{Name} whisky \u2013 {Region}" (en dash, no colon at all)
    // Verified against all 139 real titles in distillery_inventory.json.
    var m = fullTitle.match(/^(.+?)\s+(?:Distillery(?:\s+Guide)?|Whisky)\s*:/i);
    if (m) return m[1].trim();
    m = fullTitle.match(/^([^:]+):/);
    if (m) return m[1].trim();
    m = fullTitle.match(/^(.*?)\s+whisky\b/i);
    if (m) return m[1].trim();
    return fullTitle.split('|')[0].trim();
  }

  function statusColor(statusName) {
    var key = (statusName || "").trim().toLowerCase();
    return STATUS_COLORS[key] || STATUS_DEFAULT_COLOR;
  }

  function findEmbeddedTermName(post, taxonomySlug) {
    var groups = (post._embedded && post._embedded["wp:term"]) || [];
    for (var g = 0; g < groups.length; g++) {
      for (var t = 0; t < groups[g].length; t++) {
        var term = groups[g][t];
        if (term.taxonomy === taxonomySlug) return decodeHtmlEntities(term.name);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ //
  // Data fetching
  // ------------------------------------------------------------------ //

  function fetchTermIdBySlug(taxonomy, slug) {
    var url = WP_BASE_URL + "/wp-json/wp/v2/" + taxonomy + "?slug=" + encodeURIComponent(slug);
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error("Could not look up '" + slug + "' under " + taxonomy + " (HTTP " + r.status + ")");
        return r.json();
      })
      .then(function (terms) {
        if (!terms.length) throw new Error("No " + taxonomy + " term found with slug '" + slug + "'");
        return terms[0].id;
      });
  }

  function fetchAllScotlandRegionIds(excludedNames) {
    var excluded = (excludedNames || []).map(function (n) { return n.trim().toLowerCase(); });
    var url = WP_BASE_URL + "/wp-json/wp/v2/" + REGION_TAXONOMY + "?per_page=100";
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error("Could not load the region list (HTTP " + r.status + ")");
        return r.json();
      })
      .then(function (terms) {
        var kept = terms.filter(function (t) {
          return excluded.indexOf(decodeHtmlEntities(t.name).trim().toLowerCase()) === -1;
        });
        if (!kept.length) throw new Error("No region terms left after exclusions under " + REGION_TAXONOMY);
        return kept.map(function (t) { return t.id; });
      });
  }

  function fetchDistilleriesPage(taxonomy, termIds, pageNum) {
    var url = WP_BASE_URL + "/wp-json/wp/v2/pages?" + taxonomy + "=" + termIds.join(",") +
      "&per_page=100&page=" + pageNum + "&_embed=1";
    return fetch(url).then(function (r) {
      if (!r.ok) {
        if (r.status === 400 && pageNum > 1) return []; // past the last page
        throw new Error("Could not load distillery pages (HTTP " + r.status + ")");
      }
      return r.json();
    });
  }

  function fetchAllPages(taxonomy, termIds) {
    function loadPage(pageNum, accumulated) {
      return fetchDistilleriesPage(taxonomy, termIds, pageNum).then(function (posts) {
        if (!posts.length) return accumulated;
        var next = accumulated.concat(posts);
        if (posts.length < 100) return next; // short page -- no more results
        return loadPage(pageNum + 1, next);
      });
    }
    return loadPage(1, []);
  }

  function postsToDistilleries(posts, includeRegion) {
    var distilleries = [];
    var skipped = 0;
    posts.forEach(function (post) {
      var lat = parseFloat(post.meta && post.meta.meta_distillery_latitude);
      var lng = parseFloat(post.meta && post.meta.meta_distillery_longitude);
      if (isNaN(lat) || isNaN(lng)) {
        skipped++;
        return; // no coordinates yet -- skip rather than plot (0,0)
      }
      var d = {
        name: shortDistilleryName(decodeHtmlEntities((post.title && post.title.rendered) || "(untitled)")),
        lat: lat,
        lng: lng,
        link: post.link,
        whisky_style: findEmbeddedTermName(post, "tax_distillery_whisky_type") || "Unknown",
        status: findEmbeddedTermName(post, "tax_distillery_status") || "Unknown"
      };
      if (includeRegion) d.region = findEmbeddedTermName(post, "tax_distillery_region") || "Unknown";
      distilleries.push(d);
    });
    return { distilleries: distilleries, skipped: skipped, total: posts.length };
  }

  function fetchDistilleriesForConfig(config) {
    if (config.mode === "all-scotland") {
      return fetchAllScotlandRegionIds(config.excludedRegionNames)
        .then(function (ids) { return fetchAllPages(REGION_TAXONOMY, ids); })
        .then(function (posts) { return postsToDistilleries(posts, true); });
    }
    var taxonomy = config.mode === "subregion" ? SUBREGION_TAXONOMY : REGION_TAXONOMY;
    return fetchTermIdBySlug(taxonomy, config.regionSlug)
      .then(function (id) { return fetchAllPages(taxonomy, [id]); })
      .then(function (posts) { return postsToDistilleries(posts, false); });
  }

  // ------------------------------------------------------------------ //
  // DOM construction
  // ------------------------------------------------------------------ //

  function buildShell(root, config, idPrefix) {
    var showRegionFilter = config.mode === "all-scotland";
    root.innerHTML =
      '<div class="sd-map-wrap">' +
        '<div class="sd-map-header">' +
          '<div>' +
            '<h2>' + config.title + '</h2>' +
            '<div class="sd-sub">' + (config.subtitle || "") + '</div>' +
          '</div>' +
          '<div class="sd-filter-bar">' +
            (showRegionFilter ?
              '<div class="sd-filter-group">' +
                '<label for="' + idPrefix + '-region">Region:</label>' +
                '<select id="' + idPrefix + '-region"><option value="all">All regions</option></select>' +
              '</div>' : '') +
            '<div class="sd-filter-group">' +
              '<label for="' + idPrefix + '-style">Whisky style:</label>' +
              '<select id="' + idPrefix + '-style"><option value="all">All styles</option></select>' +
            '</div>' +
            '<div class="sd-filter-group">' +
              '<label for="' + idPrefix + '-status">Status:</label>' +
              '<select id="' + idPrefix + '-status"><option value="all">All statuses</option></select>' +
            '</div>' +
            '<div class="sd-legend">' +
              '<span><span class="sd-legend-dot" style="background:#2e7d32;"></span>Active</span>' +
              '<span><span class="sd-legend-dot" style="background:#c9a227;"></span>In planning / Under construction</span>' +
            '</div>' +
            '<span class="sd-count-badge" id="' + idPrefix + '-count"></span>' +
          '</div>' +
        '</div>' +
        '<div class="sd-map-canvas" id="' + idPrefix + '-canvas">' +
          '<div class="sd-status-msg" id="' + idPrefix + '-statusmsg">Loading distilleries\u2026</div>' +
        '</div>' +
      '</div>';
  }

  function setStatusMsg(canvasEl, idPrefix, text, isError) {
    var existing = document.getElementById(idPrefix + "-statusmsg");
    if (existing) existing.remove();
    if (!text) return;
    var div = document.createElement("div");
    div.id = idPrefix + "-statusmsg";
    div.className = "sd-status-msg" + (isError ? " sd-error" : "");
    div.textContent = text;
    canvasEl.appendChild(div);
  }

  // ------------------------------------------------------------------ //
  // Map + marker logic
  // ------------------------------------------------------------------ //

  function pinIcon(color) {
    return L.divIcon({
      className: '',
      html: '<div class="sd-distillery-pin" style="background:' + color + ';"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
  }

  // ------------------------------------------------------------------ //
  // Public entry point
  // ------------------------------------------------------------------ //

  function init(containerId, config) {
    var root = document.getElementById(containerId);
    if (!root) {
      console.error("SDDistilleryMap.init: no element with id '" + containerId + "' found");
      return;
    }
    if (root._sdInitialized) return;
    root._sdInitialized = true;

    var idPrefix = containerId;
    buildShell(root, config, idPrefix);

    var canvasEl = document.getElementById(idPrefix + "-canvas");

    if (typeof L === "undefined") {
      setStatusMsg(canvasEl, idPrefix, "Map library didn't load -- check the Leaflet enqueue in functions.php.", true);
      return;
    }
    if (typeof L.markerClusterGroup === "undefined") {
      setStatusMsg(canvasEl, idPrefix, "Marker clustering library didn't load -- check the Leaflet.markercluster <script> tag on this page.", true);
      return;
    }

    var view = config.initialView || [56.8, -4.5, 6];
    var map = L.map(canvasEl, { scrollWheelZoom: true }).setView([view[0], view[1]], view[2]);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(map);

    var fitBoundsOptions = config.fitBounds || { padding: [40, 40] };

    fetchDistilleriesForConfig(config)
      .then(function (result) {
        setStatusMsg(canvasEl, idPrefix, null);
        if (!result.distilleries.length) {
          setStatusMsg(canvasEl, idPrefix, "No distilleries with coordinates found for this region yet.", true);
          return;
        }
        var showRegionFilter = config.mode === "all-scotland";
        var bounds = L.latLngBounds(result.distilleries.map(function (d) { return [d.lat, d.lng]; }));
        setupMapWithData(map, result.distilleries, idPrefix, showRegionFilter, fitBoundsOptions, bounds);
        if (result.skipped > 0) {
          console.warn("SDDistilleryMap (" + containerId + "): " + result.skipped + " of " + result.total +
            " page(s) skipped -- missing lat/lng meta.");
        }
      })
      .catch(function (err) {
        setStatusMsg(canvasEl, idPrefix, "Couldn't load the map: " + err.message, true);
        console.error("SDDistilleryMap (" + containerId + "):", err);
      });
  }

  // Real fitBounds-aware version of setupMapWithData (the earlier one above
  // has a placeholder for fitBounds options -- this is the one actually used).
  function setupMapWithData(map, distilleries, idPrefix, showRegionFilter, fitBoundsOptions, bounds) {
    var clusterGroup;

    function buildClusterGroup(regionFilter, styleFilter, statusFilter) {
      var group = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        iconCreateFunction: function (cluster) {
          return L.divIcon({
            html: '<div class="sd-cluster-badge">' + cluster.getChildCount() + '</div>',
            className: '',
            iconSize: [38, 38]
          });
        }
      });

      var shown = 0;
      distilleries.forEach(function (d) {
        if (showRegionFilter && regionFilter !== 'all' && d.region !== regionFilter) return;
        if (styleFilter !== 'all' && d.whisky_style !== styleFilter) return;
        if (statusFilter !== 'all' && d.status !== statusFilter) return;
        shown++;

        var color = statusColor(d.status);
        var marker = L.marker([d.lat, d.lng], { icon: pinIcon(color) });
        var labelContent = d.link
          ? '<a href="' + d.link + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">' + d.name + '</a>'
          : d.name;
        marker.bindTooltip(labelContent, {
          permanent: true,
          direction: 'right',
          offset: [10, 0],
          className: 'sd-pin-label',
          interactive: true  // required for the tooltip to receive clicks at all --
                              // Leaflet's own CSS sets pointer-events:none on tooltips
                              // by default, only .leaflet-tooltip.leaflet-interactive
                              // gets pointer-events:auto (verified against leaflet.css
                              // v1.9.4 directly, not assumed)
        });
        var linkHtml = d.link
          ? '<a class="sd-popup-link" href="' + d.link + '">View distillery profile &rarr;</a>'
          : '';
        var regionTagHtml = showRegionFilter
          ? '<span class="sd-popup-style">' + d.region + '</span>'
          : '';
        marker.bindPopup(
          '<div class="sd-popup-title">' + d.name + '</div>' +
          '<div class="sd-popup-tags">' +
            regionTagHtml +
            '<span class="sd-popup-style">' + d.whisky_style + '</span>' +
            '<span class="sd-popup-status" style="background:' + color + ';">' + d.status + '</span>' +
          '</div>' +
          linkHtml
        );
        group.addLayer(marker);
      });

      var countBadge = document.getElementById(idPrefix + '-count');
      if (countBadge) countBadge.textContent = shown + ' of ' + distilleries.length + ' shown';

      return group;
    }

    function renderMarkers() {
      var regionFilter = showRegionFilter ? document.getElementById(idPrefix + '-region').value : 'all';
      var styleFilter = document.getElementById(idPrefix + '-style').value;
      var statusFilter = document.getElementById(idPrefix + '-status').value;
      if (clusterGroup) map.removeLayer(clusterGroup);
      clusterGroup = buildClusterGroup(regionFilter, styleFilter, statusFilter);
      map.addLayer(clusterGroup);
    }

    if (showRegionFilter) {
      var regions = Array.from(new Set(distilleries.map(function (d) { return d.region; }))).sort();
      var regionSelect = document.getElementById(idPrefix + '-region');
      regions.forEach(function (r) {
        var opt = document.createElement('option');
        opt.value = r; opt.textContent = r;
        regionSelect.appendChild(opt);
      });
      regionSelect.addEventListener('change', renderMarkers);
    }

    var styles = Array.from(new Set(distilleries.map(function (d) { return d.whisky_style; }))).sort();
    var styleSelect = document.getElementById(idPrefix + '-style');
    styles.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      styleSelect.appendChild(opt);
    });
    styleSelect.addEventListener('change', renderMarkers);

    var statuses = Array.from(new Set(distilleries.map(function (d) { return d.status; }))).sort();
    var statusSelect = document.getElementById(idPrefix + '-status');
    statuses.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      statusSelect.appendChild(opt);
    });
    statusSelect.addEventListener('change', renderMarkers);

    renderMarkers();
    map.fitBounds(bounds, fitBoundsOptions);
  }

  global.SDDistilleryMap = { init: init };

})(window);
