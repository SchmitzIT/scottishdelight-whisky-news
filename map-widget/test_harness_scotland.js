const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="sd-test-scotland"></div></body></html>', {
  url: 'https://www.scottishdelight.com/scotland-map/',
  runScripts: 'dangerously',
  resources: 'usable'
});
const { window } = dom;
global.window = window;
global.document = window.document;

function FakeMarker(latlng, opts) {
  this.latlng = latlng; this.opts = opts; this._h = {};
  this.bindTooltip = function (c, o) { this.tooltipContent = c; return this; };
  this.bindPopup = function (h) { this.popupHtml = h; return this; };
  this.on = function (e, h) { this._h[e] = h; return this; };
}
var addedLayers = [];
function FakeMarkerClusterGroup() {
  this.layers = [];
  this.addLayer = function (m) { this.layers.push(m); addedLayers.push(m); };
}
var mapInstance = {
  layers: [], addLayer: function (l) { this.layers.push(l); },
  removeLayer: function (l) { this.layers = this.layers.filter(x => x !== l); },
  fitBounds: function (b, o) { this.lastFitBounds = { b, o }; },
  setView: function () { return this; },
};
global.L = window.L = {
  map: () => mapInstance,
  tileLayer: () => ({ addTo: function () { return this; } }),
  divIcon: (o) => ({ opts: o }),
  marker: (ll, o) => new FakeMarker(ll, o),
  latLngBounds: (p) => ({ points: p }),
  markerClusterGroup: () => new FakeMarkerClusterGroup()
};

var callLog = [];
function makeDistillery(name, region, page) {
  return {
    title: { rendered: name + ': Test Guide | Scottish Delight' },
    link: 'https://www.scottishdelight.com/' + name.toLowerCase() + '/',
    meta: { meta_distillery_latitude: '55.0', meta_distillery_longitude: '-4.0' },
    _embedded: { 'wp:term': [
      [{ taxonomy: 'tax_distillery_whisky_type', name: 'Single malt' }],
      [{ taxonomy: 'tax_distillery_status', name: 'Active' }],
      [{ taxonomy: 'tax_distillery_region', name: region }]
    ]}
  };
}
// Simulate 150 total distilleries across 2 pages (100 + 50) to exercise pagination
var page1 = [];
for (var i = 0; i < 100; i++) page1.push(makeDistillery('D' + i, i % 2 === 0 ? 'Lowland' : 'Highland', 1));
var page2 = [];
for (var i = 100; i < 150; i++) page2.push(makeDistillery('D' + i, 'Speyside', 2));

global.fetch = window.fetch = function (url) {
  callLog.push(url);
  if (url.indexOf('/wp-json/wp/v2/tax_distillery_region?per_page=100') !== -1) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([
        { id: 1, name: 'Lowland' },
        { id: 2, name: 'Highland' },
        { id: 3, name: 'Speyside' },
        { id: 4, name: 'Cumbria' },
        { id: 5, name: 'The Cotswolds' },
        { id: 6, name: 'Suffolk' }
      ])
    });
  }
  if (url.indexOf('/wp-json/wp/v2/pages?tax_distillery_region=') !== -1) {
    // Confirm the excluded English regions' IDs (4,5,6) are NOT in the query
    var idsParam = url.match(/tax_distillery_region=([\d,]+)/)[1];
    var ids = idsParam.split(',');
    if (ids.indexOf('4') !== -1 || ids.indexOf('5') !== -1 || ids.indexOf('6') !== -1) {
      return Promise.resolve({ ok: false, status: 500 }); // would fail the test below
    }
    var pageNum = parseInt((url.match(/[?&]page=(\d+)/) || [,'1'])[1], 10);
    if (pageNum === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve(page1) });
    if (pageNum === 2) return Promise.resolve({ ok: true, json: () => Promise.resolve(page2) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  }
  return Promise.reject(new Error('Unexpected fetch URL: ' + url));
};

var code = fs.readFileSync(__dirname + '/map-widget.js', 'utf8');
window.eval(code);

window.SDDistilleryMap.init('sd-test-scotland', {
  title: "Scotland's Distilleries",
  mode: 'all-scotland',
  excludedRegionNames: ['cumbria', 'the cotswolds', 'suffolk'],
  initialView: [56.8, -4.5, 6],
  fitBounds: { padding: [40, 40] }
});

setTimeout(function () {
  var root = window.document.getElementById('sd-test-scotland');
  var results = { pass: [], fail: [] };
  function check(name, cond) { (cond ? results.pass : results.fail).push(name); }

  check('region filter IS shown in all-scotland mode', root.innerHTML.indexOf('id="sd-test-scotland-region"') !== -1);
  check('pagination fetched both pages (2 pages calls)', callLog.filter(u => u.indexOf('/pages?') !== -1).length === 2);
  check('all 150 distilleries loaded (100 + 50 across pagination)', addedLayers.length === 150);
  check('excluded regions never appeared in the query string', callLog.every(u => {
    if (u.indexOf('/pages?') === -1) return true;
    var ids = u.match(/tax_distillery_region=([\d,]+)/)[1].split(',');
    return ids.indexOf('4') === -1 && ids.indexOf('5') === -1 && ids.indexOf('6') === -1;
  }));
  var regionOptions = root.querySelectorAll('#sd-test-scotland-region option');
  var regionValues = Array.from(regionOptions).map(o => o.value);
  check('region dropdown has Lowland, Highland, Speyside (from actual data) but not the excluded ones',
    regionValues.indexOf('Lowland') !== -1 && regionValues.indexOf('Highland') !== -1 &&
    regionValues.indexOf('Speyside') !== -1 && regionValues.indexOf('Cumbria') === -1);
  check('popup includes region tag in all-scotland mode', addedLayers[0].popupHtml.indexOf('Lowland') !== -1 || addedLayers[0].popupHtml.indexOf('Highland') !== -1);

  console.log('\n=== SCOTLAND-MODE TEST RESULTS ===');
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
}, 100);
