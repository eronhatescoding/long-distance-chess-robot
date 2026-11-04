/* Video call (Step 2) — WebRTC peer-to-peer between the two laptops.
 * Fully decoupled from chess: it only understands { type: "signal" } messages
 * (relayed by the server) and the two <video> elements it is handed.
 *
 * Signaling uses the perfect-negotiation pattern: player A is impolite,
 * player B is polite (assigned by client.js from the server's welcome).
 * ICE: public STUN for direct paths, a free public TURN relay as fallback
 * (replace with self-hosted coturn for production). Console logs each
 * candidate's type — "relay" means the media is going through TURN.
 */

window.videoCall = (() => {
  let pc = null;
  let localStream = null;
  let sendSignal = null;
  let localVideo = null;
  let remoteVideo = null;
  let pipWrap = null;
  let makingOffer = false;
  let watchdog = null;
  let camOn = true;
  let micOn = true;

  // If a negotiation stalls with no ICE activity for a long stretch, the
  // impolite side tears down and renegotiates from scratch. Checking is NOT
  // stuck — relay candidate gathering legitimately takes a while.
  const WATCHDOG_MS = 25000;

  function armWatchdog() {
    if (api.polite) return; // one side driving recovery avoids reset loops
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (!pc || pc.connectionState === "connected") return;
      if (pc.connectionState === "checking" || pc.connectionState === "connecting") {
        armWatchdog(); // still working — give it another window
        return;
      }
      console.warn("video: negotiation stuck — resetting the connection");
      resetPeer();
    }, WATCHDOG_MS);
  }

  function resetPeer() {
    clearTimeout(watchdog);
    if (pc) {
      pc.close();
      pc = null;
    }
    remoteVideo.srcObject = null;
    if (localStream && api.peerAvailable) attachTracks(ensurePeer());
  }

  const api = {
    polite: null, // set by client.js: false for A (impolite), true for B (polite)
    peerAvailable: false, // set by client.js from server events — never negotiate with nobody
    onRemoteStream: null, // optional callback(stream)
    onPeerStateChange: null, // optional callback(RTCPeerConnectionState)
    onMediaState: null, // optional callback({ camOn, micOn, active }) for the PiP buttons
    init, start, stop, hangup, handleSignal, toggleCamera, toggleMic,
    isActive: () => !!localStream,
  };

  function init({ send, localVideo: lv, remoteVideo: rv }) {
    sendSignal = send;
    localVideo = lv;
    remoteVideo = rv;
    pipWrap = lv ? lv.closest(".pip-wrap") : null;
  }

  /* ----- camera/mic toggles (PiP controls) -----
     Tracks are muted in place (enabled = false): the call stays up, the
     remote side just sees black / hears nothing. A missing device forces the
     off state — the button then reads as unavailable, honestly. */
  function setTracks(kind, on) {
    if (!localStream) return false;
    const tracks = kind === "video" ? localStream.getVideoTracks() : localStream.getAudioTracks();
    if (!tracks.length) return false;
    for (const t of tracks) t.enabled = on;
    return true;
  }

  function emitMediaState() {
    if (api.onMediaState) api.onMediaState({ camOn, micOn, active: !!localStream });
  }

  function toggleCamera() {
    camOn = !camOn;
    if (!setTracks("video", camOn)) camOn = false;
    if (pipWrap) pipWrap.classList.toggle("cam-off", !camOn);
    emitMediaState();
  }

  function toggleMic() {
    micOn = !micOn;
    if (!setTracks("audio", micOn)) micOn = false;
    emitMediaState();
  }

  function ensurePeer() {
    if (pc) return pc;
    // STUN gives plain-IP candidates for direct paths; the Metered TURN
    // relay (free tier) carries the media when NATs/firewalls make a direct
    // path impossible. Note: these credentials are visible to anyone who
    // opens dev tools — fine for prototyping, self-host coturn for real.
    const meteredAuth = {
      username: "2c5f59bed16c397bbef2c4dd",
      credential: "Dlb44uNAjOmjDjSe",
    };
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.relay.metered.ca:80" },
        { urls: "turn:standard.relay.metered.ca:80", ...meteredAuth },
        { urls: "turn:standard.relay.metered.ca:80?transport=tcp", ...meteredAuth },
        { urls: "turn:standard.relay.metered.ca:443", ...meteredAuth },
        { urls: "turns:standard.relay.metered.ca:443?transport=tcp", ...meteredAuth },
      ],
    });

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        sendSignal({ type: "signal", data: { description: pc.localDescription } });
        armWatchdog();
      } catch (err) {
        console.error("negotiation failed:", err);
      } finally {
        makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        // host/srflx = direct path, relay = going through the TURN server
        console.log(`video: ICE candidate: ${candidate.type} (${candidate.protocol})`);
        sendSignal({ type: "signal", data: { candidate } });
      }
    };

    pc.ontrack = ({ streams, track }) => {
      console.log("video: remote", track.kind, "track arrived");
      remoteVideo.srcObject = streams[0];
      // autoplay with sound can be blocked — force play and log if refused
      remoteVideo.play().catch((err) => console.warn("video: autoplay blocked:", err.message));
      if (track.kind === "video") {
        // Only switch the base layer once frames actually flow — otherwise
        // the user would stare at a black screen instead of the face.
        track.onunmute = () => {
          console.log("video: remote video frames flowing");
          if (api.onRemoteStream) api.onRemoteStream(streams[0]);
        };
        track.onmute = () => console.log("video: remote video frames stopped");
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("video: connection state:", pc.connectionState);
      if (api.onPeerStateChange) api.onPeerStateChange(pc.connectionState);
      if (pc.connectionState === "connected") clearTimeout(watchdog);
      if (pc.connectionState === "failed") {
        // Impolite side rebuilds from scratch; polite side asks for fresh
        // candidates so it doesn't fight its peer's recovery.
        if (api.polite) pc.restartIce();
        else resetPeer();
      }
    };

    if (localStream) attachTracks(pc);
    return pc;
  }

  // Add any local tracks the connection isn't sending yet. The peer can be
  // created by an incoming offer before the camera starts, so this must be
  // safe to call on an existing pc — addTrack on a stable connection fires
  // onnegotiationneeded and renegotiates.
  function attachTracks(peer) {
    for (const track of localStream.getTracks()) {
      if (peer.getSenders().some((s) => s.track === track)) continue;
      const sender = peer.addTrack(track, localStream);
      if (track.kind === "video") {
        // Cap bitrate so relayed media survives congested paths.
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 400_000;
        sender.setParameters(params).catch(() => {});
      }
    }
  }

  async function start() {
    if (!localStream) {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "camera needs a secure context — open http://localhost:8080 (not the LAN IP), or serve over HTTPS"
        );
      }
      // Ask for camera+mic, but don't fail outright if one is missing.
      // Small, low-framerate video is plenty for a face cam and survives
      // relayed/congested paths.
      const video = {
        width: { ideal: 320 },
        height: { ideal: 240 },
        frameRate: { ideal: 15 },
      };
      const attempts = [
        { video, audio: true },
        { video, audio: false },
        { video: false, audio: true },
      ];
      for (const constraints of attempts) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (err) {
          if (err.name !== "NotFoundError" && err.name !== "OverconstrainedError") throw err;
        }
      }
      if (!localStream) {
        throw new Error("no camera or microphone found on this device");
      }
      if (!localStream.getAudioTracks().length) {
        console.warn("video: no microphone, continuing video-only");
        micOn = false;
      }
      if (!localStream.getVideoTracks().length) {
        console.warn("video: no camera, continuing audio-only");
        camOn = false;
      }
      localVideo.srcObject = localStream;
      // honor any pre-armed state (buttons pressed while the tile was empty)
      for (const t of localStream.getVideoTracks()) t.enabled = camOn;
      for (const t of localStream.getAudioTracks()) t.enabled = micOn;
      if (pipWrap) {
        pipWrap.classList.remove("hidden");
        pipWrap.classList.toggle("cam-off", !camOn);
      }
      emitMediaState();
    }
    // Only negotiate when an opponent is actually connected — an offer sent
    // to nobody leaves the connection stuck in have-local-offer forever.
    if (api.peerAvailable) attachTracks(ensurePeer());
  }

  function stop() {
    clearTimeout(watchdog);
    if (localStream) {
      for (const track of localStream.getTracks()) track.stop();
      localStream = null;
    }
    camOn = true;
    micOn = true;
    localVideo.srcObject = null;
    if (pipWrap) {
      pipWrap.classList.add("hidden");
      pipWrap.classList.remove("cam-off", "show-controls");
    }
    emitMediaState();
    if (pc) {
      pc.close();
      pc = null;
    }
    remoteVideo.srcObject = null;
  }

  // End the peer connection but keep the local camera running — used when
  // the opponent disconnects; a fresh connection is negotiated on rejoin.
  function hangup() {
    clearTimeout(watchdog);
    if (pc) {
      pc.close();
      pc = null;
    }
    remoteVideo.srcObject = null;
  }

  async function handleSignal(data) {
    if (!data || !api.peerAvailable) return; // stale signal from a gone peer
    try {
      if (data.description) {
        const description = data.description;
        // Stale answer to a superseded offer (arrives after glare recovery
        // already reached stable) — safe and necessary to ignore.
        if (description.type === "answer" && pc && pc.signalingState === "stable") return;
        const collision =
          description.type === "offer" && pc && (makingOffer || pc.signalingState !== "stable");
        if (collision && !api.polite) return; // impolite side ignores colliding offer

        const peer = ensurePeer();
        await peer.setRemoteDescription(description); // implicit rollback on collision
        if (description.type === "offer") {
          await peer.setLocalDescription();
          sendSignal({ type: "signal", data: { description: peer.localDescription } });
        }
      } else if (data.candidate) {
        if (pc) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (err) {
            if (!api.polite) throw err; // harmless for polite side after rollback
          }
        }
      }
    } catch (err) {
      console.error("signal handling failed:", err);
    }
  }

  return api;
})();
