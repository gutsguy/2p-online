// AOWStage.width(buf, px): one game file serves both pages.
// The mod is built once (age-of-war-online.swf, original 650 px stage). The local 2-player page
// widens the stage header to 1000 px; the online page makes sure it is 650 px (so an old
// 1000 px file still shows the original view). Only the stage size in the header changes.
// Resolves with the bytes to load (unchanged when already that width or not readable).
(function () {
  function width(buf, px) {
    var want = px * 20;   // twips
    var u = new Uint8Array(buf);
    var body = u[0] === 0x46 ? Promise.resolve(u.subarray(8)) :
      u[0] === 0x43 && window.DecompressionStream ?
        new Response(new Blob([u.subarray(8)]).stream().pipeThrough(new DecompressionStream("deflate")))
          .arrayBuffer().then(function (b) { return new Uint8Array(b); }) :
        Promise.resolve(null);   // LZMA (ZWS) or no decompressor: leave it alone
    return body.then(function (b) {
      if (!b) return buf;
      var n = b[0] >> 3, pos = 5;
      function rd() {   // signed n-bit value
        var v = 0;
        for (var i = 0; i < n; i++, pos++) v = (v << 1) | ((b[pos >> 3] >> (7 - (pos & 7))) & 1);
        return v >= 1 << (n - 1) ? v - (1 << n) : v;
      }
      var r = [rd(), rd(), rd(), rd()], rectLen = Math.ceil((5 + 4 * n) / 8);
      if (r[1] - r[0] === want) return buf;
      r[1] = r[0] + want;
      var nb = 1;
      r.forEach(function (v) { while (v >= 1 << (nb - 1) || v < -(1 << (nb - 1))) nb++; });
      var bits = [];
      for (var i = 4; i >= 0; i--) bits.push((nb >> i) & 1);
      r.forEach(function (v) { for (var i = nb - 1; i >= 0; i--) bits.push((v >> i) & 1); });
      var rect = new Uint8Array(Math.ceil(bits.length / 8));
      bits.forEach(function (x, i) { if (x) rect[i >> 3] |= 0x80 >> (i & 7); });
      var rest = b.subarray(rectLen), out = new Uint8Array(8 + rect.length + rest.length);
      out.set([0x46, 0x57, 0x53, u[3]]);   // "FWS" + version, uncompressed
      new DataView(out.buffer).setUint32(4, out.length, true);
      out.set(rect, 8); out.set(rest, 8 + rect.length);
      return out.buffer;
    }).catch(function () { return buf; });
  }
  window.AOWStage = { width: width };
})();
