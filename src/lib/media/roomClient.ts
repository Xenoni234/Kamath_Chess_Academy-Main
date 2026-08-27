"use client";

/**
 * Client-side mediasoup room (Phase 6 v2).
 *
 * Encapsulates the mediasoup-client handshake — load a Device from the router's
 * capabilities, create send/recv transports, produce camera+mic (+ screen share),
 * and consume everyone else's producers — behind a small React hook. Signalling
 * rides the shared Socket.io connection via ack callbacks.
 *
 * getUserMedia needs a secure context (HTTPS or localhost), which the app has.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Device } from "mediasoup-client";
import type { types } from "mediasoup-client";
import { getSocket } from "@/lib/socket/client";

export type RemoteStream = {
  producerId: string;
  peerId: string;
  username: string;
  kind: "audio" | "video";
  screen: boolean;
  stream: MediaStream;
};

type NewProducer = {
  producerId: string;
  peerId: string;
  username: string;
  kind: "audio" | "video";
  appData?: { screen?: boolean };
};

export type MediaStatus = "idle" | "connecting" | "live" | "error";

function request<T>(event: string, data: unknown): Promise<T> {
  return new Promise((resolve) => getSocket().emit(event, data, (r: T) => resolve(r)));
}

export function useMediaRoom(classId: string, enabled: boolean) {
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [remotes, setRemotes] = useState<RemoteStream[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  const deviceRef = useRef<Device | null>(null);
  const sendRef = useRef<types.Transport | null>(null);
  const recvRef = useRef<types.Transport | null>(null);
  const camProducerRef = useRef<types.Producer | null>(null);
  const micProducerRef = useRef<types.Producer | null>(null);
  const screenProducerRef = useRef<types.Producer | null>(null);
  const consumersRef = useRef<Map<string, types.Consumer>>(new Map());
  const remotesRef = useRef<Map<string, RemoteStream>>(new Map());
  const startedRef = useRef(false);

  const syncRemotes = useCallback(() => {
    setRemotes(Array.from(remotesRef.current.values()));
  }, []);

  const consume = useCallback(
    async (p: NewProducer) => {
      const device = deviceRef.current;
      const recv = recvRef.current;
      if (!device || !recv) return;
      const params = await request<{ id: string; producerId: string; kind: "audio" | "video"; rtpParameters: types.RtpParameters; appData?: { screen?: boolean }; error?: string }>(
        "media:consume",
        { classId, transportId: recv.id, producerId: p.producerId, rtpCapabilities: device.rtpCapabilities },
      );
      if (params.error) return;
      const consumer = await recv.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });
      consumersRef.current.set(consumer.id, consumer);
      await request("media:resume-consumer", { classId, consumerId: consumer.id });
      remotesRef.current.set(p.producerId, {
        producerId: p.producerId,
        peerId: p.peerId,
        username: p.username,
        kind: params.kind,
        screen: Boolean(p.appData?.screen ?? params.appData?.screen),
        stream: new MediaStream([consumer.track]),
      });
      syncRemotes();
    },
    [classId, syncRemotes],
  );

  const start = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("connecting");
    const socket = getSocket();
    try {
      const caps = await request<{ rtpCapabilities?: types.RtpCapabilities; error?: string }>("media:capabilities", { classId });
      if (!caps.rtpCapabilities) throw new Error(caps.error ?? "no capabilities");

      const device = new Device();
      await device.load({ routerRtpCapabilities: caps.rtpCapabilities });
      deviceRef.current = device;

      // Send transport.
      const sendParams = await request<types.TransportOptions>("media:create-transport", { classId, direction: "send" });
      const send = device.createSendTransport(sendParams);
      send.on("connect", ({ dtlsParameters }, cb, errb) => {
        request("media:connect-transport", { classId, transportId: send.id, dtlsParameters }).then(() => cb()).catch(errb);
      });
      send.on("produce", ({ kind, rtpParameters, appData }, cb, errb) => {
        request<{ id: string }>("media:produce", { classId, transportId: send.id, kind, rtpParameters, appData }).then((r) => cb({ id: r.id })).catch(errb);
      });
      sendRef.current = send;

      // Recv transport.
      const recvParams = await request<types.TransportOptions>("media:create-transport", { classId, direction: "recv" });
      const recv = device.createRecvTransport(recvParams);
      recv.on("connect", ({ dtlsParameters }, cb, errb) => {
        request("media:connect-transport", { classId, transportId: recv.id, dtlsParameters }).then(() => cb()).catch(errb);
      });
      recvRef.current = recv;

      // Publish camera + mic.
      const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(media);
      const videoTrack = media.getVideoTracks()[0];
      const audioTrack = media.getAudioTracks()[0];
      if (videoTrack) camProducerRef.current = await send.produce({ track: videoTrack, appData: { kind: "cam" } });
      if (audioTrack) micProducerRef.current = await send.produce({ track: audioTrack, appData: { kind: "mic" } });

      // Consume producers already in the room, and any that arrive later.
      socket.on("media:new-producer", consume);
      socket.on("media:producer-closed", ({ producerId }: { producerId: string }) => {
        remotesRef.current.delete(producerId);
        syncRemotes();
      });
      socket.on("media:peer-left", ({ peerId }: { peerId: string }) => {
        for (const [pid, r] of remotesRef.current) if (r.peerId === peerId) remotesRef.current.delete(pid);
        syncRemotes();
      });

      const existing = await request<{ producers: NewProducer[] }>("media:producers", { classId });
      for (const p of existing.producers ?? []) await consume(p);

      setStatus("live");
    } catch (err) {
      console.error("[media] start failed:", err);
      setStatus("error");
    }
  }, [classId, consume, syncRemotes]);

  const toggleMic = useCallback(() => {
    const p = micProducerRef.current;
    if (!p) return;
    if (p.paused) p.resume();
    else p.pause();
    setMicOn(!p.paused);
  }, []);

  const toggleCam = useCallback(() => {
    const p = camProducerRef.current;
    if (!p) return;
    if (p.paused) p.resume();
    else p.pause();
    setCamOn(!p.paused);
  }, []);

  const stopScreen = useCallback(() => {
    const p = screenProducerRef.current;
    if (p) {
      request("media:close-producer", { classId, producerId: p.id });
      p.close();
      screenProducerRef.current = null;
    }
    setScreenStream((s) => {
      s?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, [classId]);

  const shareScreen = useCallback(async () => {
    const send = sendRef.current;
    if (!send || screenProducerRef.current) return;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      screenProducerRef.current = await send.produce({ track, appData: { screen: true } });
      track.onended = () => stopScreen();
      setScreenStream(display);
    } catch {
      /* user cancelled the picker */
    }
  }, [stopScreen]);

  const leave = useCallback(() => {
    const socket = getSocket();
    socket.off("media:new-producer", consume);
    socket.emit("media:leave", { classId });
    for (const c of consumersRef.current.values()) c.close();
    consumersRef.current.clear();
    screenProducerRef.current?.close();
    camProducerRef.current?.close();
    micProducerRef.current?.close();
    sendRef.current?.close();
    recvRef.current?.close();
    localStream?.getTracks().forEach((t) => t.stop());
    screenStream?.getTracks().forEach((t) => t.stop());
    remotesRef.current.clear();
    startedRef.current = false;
    setStatus("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, consume]);

  useEffect(() => {
    if (!enabled || !classId) return;
    start();
    return () => leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, classId]);

  return { status, localStream, screenStream, remotes, micOn, camOn, toggleMic, toggleCam, shareScreen, stopScreen };
}
