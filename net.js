// =====================================================================
//  Connection methods ("transports"). The game only needs:
//     t = AOWNet.create(kind, room, role, { onOpen, onMessage, onClose, onStatus })
//     t.send(text)    t.close()
//  To add a method, register a factory with AOWNet.register(kind, factory).
//
//    local  : two tabs of the same browser on one PC (development)
//    webrtc : browsers connect directly; PeerJS's free public broker is
//             only used to find each other (room code). The page may come
//             from the local folder or from the deployed site (make_site.py).
//    relay  : WebSocket relay in serve.py on the host's PC; the friend opens
//             the host's address (e.g. over Tailscale).
// =====================================================================
(function () {
  var TRANSPORTS = {};
  var LABELS = {};

  // --- local: BroadcastChannel between tabs ------------------------------
  LABELS.local = "같은 PC 테스트 (탭 2개)";
  TRANSPORTS.local = function (room, role, h) {
    var ch = new BroadcastChannel("aow-room-" + room);
    var me = role + "-" + Math.random().toString(36).slice(2, 8);
    // testing aid: ?lag=150&jitter=60 delays delivery (order is kept)
    var qp = new URLSearchParams(location.search);
    var lag = Number(qp.get("lag") || 0), jitter = Number(qp.get("jitter") || 0), last = 0;
    ch.onmessage = function (e) {
      var d = e.data;
      if (!d || d.from === me) return;
      if (!lag && !jitter) { h.onMessage(d.text); return; }
      var at = Math.max(last, Date.now() + lag + Math.random() * jitter);
      last = at;
      setTimeout(function () { h.onMessage(d.text); }, at - Date.now());
    };
    setTimeout(function () { h.onOpen(); }, 0);
    return {
      send: function (text) { ch.postMessage({ from: me, text: text }); },
      close: function () { ch.close(); }
    };
  };

  // --- webrtc: PeerJS data channel ---------------------------------------
  LABELS.webrtc = "WebRTC (방 코드, 인터넷)";
  var PEERJS_URL = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
  var ID_PREFIX = "aow2p-room-";
  function loadPeerJS(cb) {
    if (window.Peer) { cb(); return; }
    var s = document.createElement("script");
    s.src = PEERJS_URL;
    s.onload = function () { cb(); };
    s.onerror = function () { cb(new Error("PeerJS 를 불러오지 못했습니다 (인터넷 연결 확인)")); };
    document.head.appendChild(s);
  }
  TRANSPORTS.webrtc = function (room, role, h) {
    var peer = null, conn = null, closed = false, queue = [];
    function useConn(c) {
      conn = c;
      c.on("open", function () {
        h.onOpen();
        queue.forEach(function (t) { c.send(t); }); queue = [];
      });
      c.on("data", function (d) { h.onMessage(String(d)); });
      c.on("close", function () { if (!closed) h.onClose(); });
      c.on("error", function (e) { h.onStatus && h.onStatus("연결 오류: " + e, "err"); });
    }
    loadPeerJS(function (err) {
      if (err) { h.onStatus && h.onStatus(err.message, "err"); return; }
      if (role === "H") {
        peer = new Peer(ID_PREFIX + room);
        peer.on("open", function () { h.onStatus && h.onStatus("방 코드: " + room + "  — 상대가 참가하기를 기다리는 중...", "ok"); });
        peer.on("connection", function (c) {
          if (conn) { c.close(); return; }      // room is full
          useConn(c);
        });
      } else {
        peer = new Peer();
        peer.on("open", function () {
          useConn(peer.connect(ID_PREFIX + room, { reliable: true, serialization: "raw" }));
        });
      }
      peer.on("error", function (e) {
        var msg = e.type === "peer-unavailable" ? "그 방 코드를 찾을 수 없습니다." :
                  e.type === "unavailable-id" ? "이미 쓰이는 방 코드입니다. 다시 만들어 주세요." :
                  "연결 오류: " + (e.type || e);
        h.onStatus && h.onStatus(msg, "err");
      });
      peer.on("disconnected", function () { if (!closed && !conn) h.onStatus && h.onStatus("중개 서버와 연결이 끊겼습니다.", "err"); });
    });
    return {
      send: function (text) {
        if (conn && conn.open) conn.send(text);
        else queue.push(text);
      },
      close: function () { closed = true; try { conn && conn.close(); peer && peer.destroy(); } catch (e) {} },
      waitsForPeer: true
    };
  };

  // --- relay: WebSocket relay in serve.py ----------------------------------
  LABELS.relay = "중계 서버 (방장 PC, Tailscale 등)";
  TRANSPORTS.relay = function (room, role, h) {
    var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.hostname + ":" + RELAY_PORT() + "/";
    var ws = new WebSocket(url), closed = false, queue = [];
    ws.onopen = function () {
      ws.send("J" + room);
      h.onOpen();
      queue.forEach(function (t) { ws.send(t); }); queue = [];
    };
    ws.onmessage = function (e) {
      var d = String(e.data);
      if (d === "#full") { h.onStatus && h.onStatus("방이 가득 찼습니다.", "err"); return; }
      if (d === "#left") { h.onStatus && h.onStatus("상대가 나갔습니다.", "err"); return; }
      h.onMessage(d);
    };
    ws.onerror = function () { h.onStatus && h.onStatus("중계 서버에 연결할 수 없습니다 (" + url + ")", "err"); };
    ws.onclose = function () { if (!closed) h.onClose(); };
    return {
      send: function (text) { if (ws.readyState === 1) ws.send(text); else queue.push(text); },
      close: function () { closed = true; ws.close(); }
    };
  };
  function RELAY_PORT() { return Number(location.port || 80) + 1; }

  window.AOWNet = {
    kinds: function () { return Object.keys(TRANSPORTS); },
    label: function (k) { return LABELS[k] || k; },
    register: function (kind, factory, label) { TRANSPORTS[kind] = factory; if (label) LABELS[kind] = label; },
    create: function (kind, room, role, handlers) {
      var f = TRANSPORTS[kind];
      if (!f) throw new Error("unknown transport: " + kind);
      return f(room, role, handlers);
    }
  };
})();
