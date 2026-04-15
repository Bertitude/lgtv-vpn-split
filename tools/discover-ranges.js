#!/usr/bin/env node
/*
 * tools/discover-ranges.js
 *
 * Developer helper — NOT bundled into the IPK.
 *
 * Reads a tcpdump / Wireshark pcap (JSON or text export) and groups
 * destination IPs into /24 and /16 buckets so you can propose CDN ranges
 * for a given streaming app. Typical workflow:
 *
 *   1. On a machine on the same network as the TV, capture while streaming:
 *        sudo tcpdump -i any -w peacock.pcap 'tcp and host <TV_IP>'
 *   2. Export to line-per-packet text:
 *        tshark -r peacock.pcap -T fields -e ip.dst > peacock.dsts.txt
 *   3. Run this tool:
 *        node tools/discover-ranges.js --app com.peacocktv.peacockandroid \
 *             --input peacock.dsts.txt --min-hits 5
 *   4. Review the output and paste into service/cdn-ranges.json.
 *
 * We intentionally don't read pcap directly — parsing pcap in pure JS is
 * a lot of code for no real benefit when tshark exists. Input is a newline-
 * separated list of destination IPv4 addresses.
 */

'use strict';

var fs = require('fs');
var path = require('path');

function parseArgs(argv) {
  var args = { minHits: 3, format: 'json' };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--app') { args.app = argv[++i]; }
    else if (a === '--input') { args.input = argv[++i]; }
    else if (a === '--min-hits') { args.minHits = parseInt(argv[++i], 10); }
    else if (a === '--format') { args.format = argv[++i]; }
    else if (a === '--name') { args.name = argv[++i]; }
    else if (a === '-h' || a === '--help') { args.help = true; }
    else { console.error('Unknown arg: ' + a); process.exit(2); }
  }
  return args;
}

function usage() {
  console.log([
    'Usage: node tools/discover-ranges.js --app <app-id> --input <dsts.txt>',
    '                                     [--name "Display Name"]',
    '                                     [--min-hits N] [--format json|text]',
    '',
    'Input format: one destination IPv4 address per line (use `tshark -T fields',
    '-e ip.dst` to produce this from a pcap).',
    ''
  ].join('\n'));
}

function isValidIp(ip) {
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) { return false; }
  for (var i = 1; i <= 4; i++) { if (parseInt(m[i], 10) > 255) { return false; } }
  return true;
}

function isPrivate(ip) {
  // RFC1918 + loopback + link-local + multicast — no point routing these
  // through a VPN, they'd just break local streaming discovery.
  if (/^10\./.test(ip)) { return true; }
  if (/^192\.168\./.test(ip)) { return true; }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) { return true; }
  if (/^127\./.test(ip)) { return true; }
  if (/^169\.254\./.test(ip)) { return true; }
  if (/^2(2[4-9]|3\d)\./.test(ip)) { return true; }
  return false;
}

function toSlash24(ip) { return ip.replace(/\.\d+$/, '.0') + '/24'; }
function toSlash16(ip) { return ip.replace(/\.\d+\.\d+$/, '.0.0') + '/16'; }

function main() {
  var args = parseArgs(process.argv);
  if (args.help || !args.app || !args.input) { usage(); process.exit(args.help ? 0 : 2); }

  var raw;
  try {
    raw = fs.readFileSync(args.input, 'utf8');
  } catch (e) {
    console.error('Cannot read ' + args.input + ': ' + e.message);
    process.exit(1);
  }

  var hits24 = Object.create(null);
  var hits16 = Object.create(null);
  var total = 0, skipped = 0;

  raw.split(/\r?\n/).forEach(function (line) {
    var ip = line.trim();
    if (!ip) { return; }
    if (!isValidIp(ip)) { skipped++; return; }
    if (isPrivate(ip)) { skipped++; return; }
    total++;
    var s24 = toSlash24(ip);
    var s16 = toSlash16(ip);
    hits24[s24] = (hits24[s24] || 0) + 1;
    hits16[s16] = (hits16[s16] || 0) + 1;
  });

  // Promote tightly-clustered /24s into their parent /16 if the /16 is
  // dense enough (>4 contributing /24s). This keeps the output readable
  // without bleeding into unrelated networks.
  var kept = [];
  var consumedBy16 = {};
  Object.keys(hits16).forEach(function (k) {
    var prefix = k.replace(/\.0\.0\/16$/, '.');
    var contributors = 0;
    Object.keys(hits24).forEach(function (k24) {
      if (k24.indexOf(prefix) === 0) { contributors++; }
    });
    if (contributors >= 4 && hits16[k] >= args.minHits) {
      kept.push({ cidr: k, hits: hits16[k], contributors: contributors });
      Object.keys(hits24).forEach(function (k24) {
        if (k24.indexOf(prefix) === 0) { consumedBy16[k24] = true; }
      });
    }
  });
  Object.keys(hits24).forEach(function (k) {
    if (consumedBy16[k]) { return; }
    if (hits24[k] < args.minHits) { return; }
    kept.push({ cidr: k, hits: hits24[k], contributors: 1 });
  });

  kept.sort(function (a, b) { return b.hits - a.hits; });

  if (args.format === 'text') {
    console.log('# ' + total + ' packets analysed, ' + skipped + ' skipped, ' +
                kept.length + ' candidate ranges');
    kept.forEach(function (r) {
      console.log(r.cidr + '\t' + r.hits + ' hits' +
        (r.contributors > 1 ? ('\t(' + r.contributors + ' /24s)') : ''));
    });
    return;
  }

  var fragment = {
    apps: {}
  };
  fragment.apps[args.app] = {
    name: args.name || args.app,
    notes: 'Generated by tools/discover-ranges.js from ' +
      path.basename(args.input) + ' (' + total + ' packets, min-hits=' +
      args.minHits + '). Review before committing.',
    ranges: kept.map(function (r) { return r.cidr; })
  };
  console.log(JSON.stringify(fragment, null, 2));
}

if (require.main === module) { main(); }

module.exports = { isValidIp: isValidIp, isPrivate: isPrivate, toSlash24: toSlash24, toSlash16: toSlash16 };
