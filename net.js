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
//    cf     : our own relay on Cloudflare Workers (relay-cf/); passes
//             networks where direct connection is blocked.
//    mqtt   : messages go through a free public MQTT broker over secure
//             WebSocket; spare relay if the Cloudflare one is unreachable.
//    auto   : webrtc first; if the direct connection does not open within a
//             few seconds, the guest switches to cf, and to mqtt if cf fails.
//             The host listens on all of them and uses whichever the guest's
//             first message arrives on.
//
//  Testing aids: ?nodirect=1 makes WebRTC unable to connect (relay-only ICE
//  with no TURN server), like a network that blocks direct connections.
//  ?nocf=1 skips the Cloudflare relay; ?cf=ws://127.0.0.1:18780 uses a local
//  relay (npm run dev in relay-cf/).
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
    var opts = {};
    if (new URLSearchParams(location.search).has("nodirect"))
      opts.config = { iceServers: [], iceTransportPolicy: "relay" };
    function useConn(c) {
      conn = c;
      var pc = c.peerConnection;
      if (pc) pc.addEventListener("iceconnectionstatechange", function () {
        if (!closed && pc.iceConnectionState === "failed")
          h.onStatus && h.onStatus("직접 연결에 실패했습니다 (네트워크가 막고 있음). 연결 방식을 '자동'으로 해 보세요.", "err");
      });
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
        peer = new Peer(ID_PREFIX + room, opts);
        peer.on("open", function () { h.onStatus && h.onStatus("방 코드: " + room + "  — 상대가 참가하기를 기다리는 중...", "ok"); });
        peer.on("connection", function (c) {
          if (conn) { c.close(); return; }      // room is full
          useConn(c);
        });
      } else {
        peer = new Peer(opts);
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

  // --- cf: our relay on Cloudflare Workers (relay-cf/) -----------------------
  // Set after deploying relay-cf ("npm run deploy" prints the address).
  var CF_RELAY = "wss://aow-2p-relay.gutsguy.workers.dev";
  function cfUrl() {
    var qp = new URLSearchParams(location.search);
    if (qp.has("nocf")) return "";
    return (qp.get("cf") || CF_RELAY).replace(/^http/, "ws").replace(/\/$/, "");
  }
  LABELS.cf = "인터넷 중계 (Cloudflare)";
  TRANSPORTS.cf = function (room, role, h) {
    var base = cfUrl(), ws = null, closed = false, open = false, queue = [];
    function fail(msg) { if (!closed) { closed = true; h.onStatus && h.onStatus(msg, "err"); } }
    if (!base) setTimeout(function () { fail("Cloudflare 중계 주소가 설정되지 않았습니다."); }, 0);
    else {
      ws = new WebSocket(base + "/r/" + room + "/" + role);
      var t = setTimeout(function () { if (!open) { try { ws.close(); } catch (e) {} fail("Cloudflare 중계 서버가 응답하지 않습니다."); } }, 8000);
      ws.onopen = function () {
        if (closed) return;
        open = true; clearTimeout(t);
        h.onOpen();
        queue.forEach(function (m) { ws.send(m); }); queue = [];
      };
      ws.onmessage = function (e) { if (!closed) h.onMessage(String(e.data)); };
      ws.onerror = function () { if (!open) { clearTimeout(t); fail("Cloudflare 중계 서버에 연결할 수 없습니다."); } };
      ws.onclose = function () {
        clearTimeout(t);
        if (!open) fail("Cloudflare 중계 서버에 연결할 수 없습니다.");
        else if (!closed) { closed = true; h.onClose(); }
      };
    }
    return {
      send: function (text) { if (open && ws.readyState === 1) ws.send(text); else if (!open) queue.push(text); },
      close: function () { closed = true; try { ws && ws.close(); } catch (e) {} }
    };
  };

  // --- mqtt: free public broker over secure WebSocket ------------------------
  LABELS.mqtt = "인터넷 중계 (공개 MQTT 서버)";
  var MQTT_URL = "https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js";
  var BROKERS = ["wss://broker.emqx.io:8084/mqtt", "wss://broker.hivemq.com:8884/mqtt"];
  var TOPIC = "aow2p-r7q/";
  function loadMqtt(cb) {
    if (window.mqtt) { cb(); return; }
    var s = document.createElement("script");
    s.src = MQTT_URL;
    s.onload = function () { cb(); };
    s.onerror = function () { cb(new Error("중계 모듈을 불러오지 못했습니다 (인터넷 연결 확인)")); };
    document.head.appendChild(s);
  }
  TRANSPORTS.mqtt = function (room, role, h) {
    var client = null, closed = false, queue = [];
    var inbox = TOPIC + room + "/" + role, outbox = TOPIC + room + "/" + (role === "H" ? "G" : "H");
    var dec = new TextDecoder();
    function tryBroker(i) {
      if (closed) return;
      if (i >= BROKERS.length) { h.onStatus && h.onStatus("인터넷 중계 서버에 연결할 수 없습니다.", "err"); return; }
      var c = window.mqtt.connect(BROKERS[i], { connectTimeout: 8000, reconnectPeriod: 0, clean: true });
      var ok = false, moved = false;
      function next() { if (moved || ok) return; moved = true; try { c.end(true); } catch (e) {} tryBroker(i + 1); }
      var t = setTimeout(next, 9000);
      c.on("connect", function () {
        if (moved) return;
        ok = true; clearTimeout(t);
        c.subscribe(inbox, { qos: 0 }, function (err) {
          if (closed) return;
          if (err) { h.onStatus && h.onStatus("중계 서버 오류: " + err, "err"); return; }
          client = c;
          h.onOpen();
          queue.forEach(function (m) { c.publish(outbox, m); }); queue = [];
        });
      });
      c.on("message", function (topic, payload) { if (!closed) h.onMessage(dec.decode(payload)); });
      c.on("error", function () { clearTimeout(t); next(); });
      c.on("close", function () {
        if (!ok) { clearTimeout(t); next(); }
        else if (!closed) { closed = true; h.onClose(); }
      });
    }
    loadMqtt(function (err) {
      if (err) { h.onStatus && h.onStatus(err.message, "err"); return; }
      tryBroker(0);
    });
    return {
      send: function (text) { if (client) client.publish(outbox, text); else queue.push(text); },
      close: function () { closed = true; try { client && client.end(true); } catch (e) {} }
    };
  };

  // --- auto: direct (webrtc) first, then our relay (cf), then public mqtt ------
  LABELS.auto = "자동 (직접 연결, 안 되면 인터넷 중계)";
  var FALLBACK_MS = 8000;
  var KIND = { direct: "webrtc", cf: "cf", mqtt: "mqtt" };
  TRANSPORTS.auto = function (room, role, h) {
    var paths = {}, tried = {}, active = null, closed = false, opened = false, timer = null;
    var chain = cfUrl() ? ["direct", "cf", "mqtt"] : ["direct", "mqtt"];
    function choose(name) {
      if (active) return;
      active = name;
      Object.keys(paths).forEach(function (k) { if (k !== name) { paths[k].close(); delete paths[k]; } });
      h.onStatus && h.onStatus(name === "direct" ? "직접 연결됨" : "인터넷 중계로 연결됨", "ok");
    }
    // guest: give up on path `name` and try the next one in the chain
    function next(name) {
      if (closed || active || role !== "G") return;
      if (paths[name]) { paths[name].close(); delete paths[name]; }
      var i = chain.indexOf(name) + 1;
      while (i < chain.length && tried[chain[i]]) i++;
      if (i >= chain.length) { h.onStatus && h.onStatus("연결할 수 있는 방법을 찾지 못했습니다.", "err"); return; }
      clearTimeout(timer);
      h.onStatus && h.onStatus(name === "direct" ? "직접 연결이 안 돼서 인터넷 중계로 연결하는 중..." :
                               "다른 인터넷 중계로 연결하는 중...");
      start(chain[i]);
    }
    function start(name) {
      tried[name] = true;
      paths[name] = TRANSPORTS[KIND[name]](room, role, {
        onOpen: function () {
          if (closed || !paths[name]) return;
          if (role === "G") { clearTimeout(timer); choose(name); }
          // host: the path is chosen by the guest's first message
          if (!opened) { opened = true; h.onOpen(); }
        },
        onMessage: function (t) {
          if (closed || !paths[name]) return;
          if (role === "H") choose(name);
          if (active === name) h.onMessage(t);
        },
        onClose: function () {
          if (closed) return;
          if (active === name) h.onClose();
          else if (!active) next(name);
        },
        onStatus: function (t, cls) {
          if (closed || !paths[name]) return;
          if (active && active !== name) return;
          if (!active && cls === "err") {
            if (role === "G") next(name);
            else if (name !== "direct") { paths[name].close(); delete paths[name]; }   // host keeps the others
            if (role === "G" || name !== "direct") return;
          }
          if (!active && role === "H" && cls !== "err") return;   // the page shows the room code itself
          h.onStatus && h.onStatus(t, cls);
        }
      });
    }
    if (role === "H") chain.forEach(start);
    else { start("direct"); timer = setTimeout(function () { next("direct"); }, FALLBACK_MS); }
    return {
      send: function (text) {
        if (active) { paths[active] && paths[active].send(text); return; }
        Object.keys(paths).forEach(function (k) { paths[k].send(text); });
      },
      close: function () {
        closed = true; clearTimeout(timer);
        Object.keys(paths).forEach(function (k) { paths[k].close(); });
      },
      path: function () { return active; }
    };
  };

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
