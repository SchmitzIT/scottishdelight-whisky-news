const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="sd-test-map"></div></body></html>', {
  url: 'https://www.scottishdelight.com/test-page/',
  runScripts: 'dangerously',
  resources: 'usable'
});

const { window } = dom;
global.window = window;
global.document = window.document;

// --- Minimal Leaflet mock, just enough surface area to exercise our code paths ---
function FakeLatLngBounds(points) {
  this.points = points;
}
function FakeMarker(latlng, opts) {
  this.latlng = latlng;
  this.opts = opts;
  this._tooltipHandlers = {};
  this.bindTooltip = function (content, tooltipOpts) {
    this.tooltipContent = content;
    this.tooltipOpts = tooltipOpts;
    // simulate tooltipopen firing immediately, like Leaflet does for permanent tooltips
    var fakeEl = window.document.createElement('div');
    fakeEl.className = tooltipOpts.className;
    fakeEl.textContent = content;
    var self = this;
    setTimeout(function () {
      if (self._tooltipHandlers['tooltipopen']) {
        self._tooltipHandlers['tooltipopen']({ tooltip: { getElement: function () { return fakeEl; } } });
      }
    }, 0);
    return this;
  };
  this.bindPopup = function (html) { this.popupHtml = html; return this; };
  this.on = function (evt, handler) { this._tooltipHandlers[evt] = handler; return this; };
}
var addedLayers = [];
function FakeMarkerClusterGroup() {
  this.layers = [];
  this.addLayer = function (m) { this.layers.push(m); addedLayers.push(m); };
}
var mapInstance = {
  layers: [],
  addLayer: function (l) { this.layers.push(l); },
  removeLayer: function (l) { this.layers = this.layers.filter(x => x !== l); },
  fitBounds: function (b, opts) { this.lastFitBounds = { b, opts }; },
  setView: function () { return this; },
};

global.L = {
  map: function (el, opts) { return mapInstance; },
  tileLayer: function () { return { addTo: function () { return this; } }; },
  divIcon: function (opts) { return { opts: opts }; },
  marker: function (latlng, opts) { return new FakeMarker(latlng, opts); },
  latLngBounds: function (points) { return new FakeLatLngBounds(points); },
  markerClusterGroup: function () { return new FakeMarkerClusterGroup(); }
};
window.L = global.L;

// --- Mock fetch: simulate the WP REST API for a "region" mode fetch ---
var callLog = [];
global.fetch = window.fetch = function (url) {
  callLog.push(url);
  console.error('FETCH:', url);
  if (url.indexOf('/wp-json/wp/v2/tax_distillery_region?slug=lowland') !== -1) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 62, name: 'Lowland' }]) });
  }
  if (url.indexOf('/wp-json/wp/v2/pages?tax_distillery_region=62') !== -1) {
    var page = parseInt((url.match(/[?&]page=(\d+)/) || [,'1'])[1], 10);
    console.error('  -> matched pages branch, page=', page, 'page>1?', page > 1);
    if (page > 1) return Promise.resolve({ ok: false, status: 400 });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([
        {
          title: { rendered: 'Glenkinchie Distillery: The Edinburgh Malt&#8217;s History &amp; Whisky Guide | Scottish Delight' },
          link: 'https://www.scottishdelight.com/glenkinchie/',
          meta: { meta_distillery_latitude: '55.8906004', meta_distillery_longitude: '-2.8913282' },
          _embedded: { 'wp:term': [
            [{ taxonomy: 'tax_distillery_whisky_type', name: 'Single malt' }],
            [{ taxonomy: 'tax_distillery_status', name: 'Active' }]
          ]}
        },
        {
          // No coordinates -- should be SKIPPED, not plotted at (0,0)
          title: { rendered: 'Some Draft Distillery: Coming Soon | Scottish Delight' },
          link: 'https://www.scottishdelight.com/some-draft/',
          meta: { meta_distillery_latitude: '', meta_distillery_longitude: '' },
          _embedded: { 'wp:term': [
            [{ taxonomy: 'tax_distillery_whisky_type', name: 'Single malt' }],
            [{ taxonomy: 'tax_distillery_status', name: 'In planning' }]
          ]}
        }
      ])
    });
  }
  return Promise.reject(new Error('Unexpected fetch URL in test: ' + url));
};

// --- Load the actual module under test ---
var code = fs.readFileSync(__dirname + '/map-widget.js', 'utf8');
window.eval(code);

// --- Run it ---
window.SDDistilleryMap.init('sd-test-map', {
  title: 'Lowland Distilleries',
  subtitle: 'Test subtitle',
  mode: 'region',
  taxonomy: 'tax_distillery_region',
  regionSlug: 'lowland',
  initialView: [55.7, -3.6, 8],
  fitBounds: { padding: [40, 40] }
});

// Give the promise chain time to resolve
setTimeout(function () {
  var root = window.document.getElementById('sd-test-map');
  var results = { pass: [], fail: [] };

  function check(name, cond) {
    if (cond) results.pass.push(name); else results.fail.push(name);
  }

  check('shell rendered (header title present)', root.innerHTML.indexOf('Lowland Distilleries') !== -1);
  check('whisky style filter label says "Whisky style:" not "Whisky_style:"', root.innerHTML.indexOf('Whisky style:') !== -1 && root.innerHTML.indexOf('Whisky_style') === -1);
  check('no region filter shown in single-region mode', root.innerHTML.indexOf('id="sd-test-map-region"') === -1);
  check('fetched the term-id lookup URL', callLog.some(u => u.indexOf('slug=lowland') !== -1));
  check('fetched the pages URL with the resolved term id (62)', callLog.some(u => u.indexOf('tax_distillery_region=62') !== -1));
  check('exactly one marker added (the one with coordinates; the no-coords one was skipped)', addedLayers.length === 1);
  check('marker tooltip label content includes an anchor tag linking to the profile (real fix -- native <a> click, not a JS event listener)',
    addedLayers[0] && addedLayers[0].tooltipContent.indexOf('<a href="https://www.scottishdelight.com/glenkinchie/"') !== -1);
  check('marker tooltip label text (inside the anchor) is the SHORT name ("Glenkinchie"), not the full SEO title',
    addedLayers[0] && addedLayers[0].tooltipContent.indexOf('>Glenkinchie<') !== -1);
  check('tooltip bound with interactive:true (required for Leaflet to apply pointer-events:auto via .leaflet-tooltip.leaflet-interactive)',
    addedLayers[0] && addedLayers[0].tooltipOpts && addedLayers[0].tooltipOpts.interactive === true);
  check('marker popup contains the profile link', addedLayers[0] && addedLayers[0].popupHtml.indexOf('View distillery profile') !== -1);
  check('marker popup contains the whisky style tag', addedLayers[0] && addedLayers[0].popupHtml.indexOf('Single malt') !== -1);
  check('marker pin color reflects status (Active = green)', addedLayers[0] && addedLayers[0].opts.icon.opts.html.indexOf('#2e7d32') !== -1);
  check('map.fitBounds was called', !!mapInstance.lastFitBounds);
  check('count badge reflects 1 of 1 shown', document.getElementById('sd-test-map-count').textContent === '1 of 1 shown');

  console.log('\n=== TEST RESULTS ===');
  console.log('PASS (' + results.pass.length + '):');
  results.pass.forEach(p => console.log('  \u2713 ' + p));
  if (results.fail.length) {
    console.log('FAIL (' + results.fail.length + '):');
    results.fail.forEach(f => console.log('  \u2717 ' + f));
    process.exit(1);
  } else {
    console.log('\nAll checks passed.');
    process.exit(0);
  }
}, 50);
