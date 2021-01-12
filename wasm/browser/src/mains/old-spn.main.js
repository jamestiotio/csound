import * as Comlink from "comlink";
import ScriptProcessorNodeWorker from "@root/workers/old-spn.worker";
import log, { logSPN } from "@root/logger";
import { messageEventHandler } from "@root/mains/messages.main";
import { WebkitAudioContext } from "@root/utils";

// we reuse the spnWorker
// since it handles multiple
// audio Contexts via UID.
let spnWorker;
let proxyPort;

let UID = 0;

class ScriptProcessorNodeMainThread {
  constructor({ audioContext, audioContextIsProvided, autoConnect }) {
    this.autoConnect = autoConnect;
    this.audioContextIsProvided = audioContextIsProvided;

    this.audioContext = audioContext;
    this.currentPlayState = undefined;
    this.csoundWorkerMain = undefined;

    // never default these, get it from
    // csound-worker before starting
    this.sampleRate = undefined;
    this.inputsCount = undefined;
    this.outputsCount = undefined;
    this.hardwareBufferSize = undefined;
    this.softwareBufferSize = undefined;

    this.initIframe = this.initIframe.bind(this);
    this.initialize = this.initialize.bind(this);
    this.onPlayStateChange = this.onPlayStateChange.bind(this);
    this.scriptProcessorNode = true;
    logSPN("ScriptProcessorNodeMainThread was constructed");
  }

  async terminateInstance() {
    delete this.onPlayStateChange;
    if (window[`__csound_wasm_iframe_parent_${this.contextUid}Node`]) {
      window[`__csound_wasm_iframe_parent_${this.contextUid}Node`].disconnect();
      delete window[`__csound_wasm_iframe_parent_${this.contextUid}Node`].disconnect();
    }
    if (this.audioContext) {
      if (this.audioContext.state !== "closed") {
        try {
          await this.audioContext.close();
        } catch (error) {}
      }
      delete this.audioContext;
    }
    if (proxyPort) {
      proxyPort[Comlink.releaseProxy]();
      proxyPort = undefined;
    }
    if (this.iFrameElement) {
      this.iFrameElement.parentNode.removeChild(this.iFrameElement);
    }
    spnWorker = undefined;
    UID = 0;
    Object.keys(this).forEach((key) => delete this[key]);
  }

  async onPlayStateChange(newPlayState) {
    if (this.currentPlayState === newPlayState) {
      return;
    }

    switch (newPlayState) {
      case "realtimePerformanceStarted": {
        logSPN("event received: realtimePerformanceStarted");
        this.currentPlayState = newPlayState;
        await this.initialize();
        if (this.csoundWorkerMain.startPromiz) {
          // hacky SAB timing fix when starting
          // eventually, replace this spaghetti with
          // private/internal event emitters
          const startPromiz = this.csoundWorkerMain.startPromiz;
          setTimeout(() => {
            startPromiz();
          }, 0);
          delete this.csoundWorkerMain.startPromiz;
        }

        break;
      }
      case "realtimePerformanceEnded": {
        logSPN("event received: realtimePerformanceEnded");
        if (window[`__csound_wasm_iframe_parent_${this.contextUid}Node`]) {
          window[`__csound_wasm_iframe_parent_${this.contextUid}Node`].disconnect();
          delete window[`__csound_wasm_iframe_parent_${this.contextUid}Node`].disconnect();
        }
        break;
      }
      default: {
        break;
      }
    }
    this.currentPlayState = newPlayState;
    if (
      proxyPort &&
      (newPlayState !== "realtimePerformanceStarted" || newPlayState !== "renderStarted")
    ) {
      await proxyPort.setPlayState({
        contextUid: this.contextUid,
        newPlayState,
      });
    }
  }

  async initIframe() {
    // HACK FROM (but it works just fine when adding modern security models)
    // https://github.com/GoogleChromeLabs/audioworklet-polyfill/blob/274792e5e3d189e04c9496bed24129118539b4b5/src/realm.js#L18-L20
    if (typeof window === "undefined" || typeof window.document === "undefined") {
      throw "Can only run SPN in Browser scope";
    }

    const parentScope = window.document;
    const iFrameHtml = [
      `<!doctype html>`,
      `<html lang="en">`,
      `<head>`,
      `</head>`,
      `<body>`,
      `<script type="text/javascript" src="${ScriptProcessorNodeWorker()}"></script>`,
      `</body>`,
    ].join("\n");

    const iFrameBlob = new Blob([iFrameHtml], { type: "text/html" });
    const iFrame = document.createElement("iframe");
    this.iFrameElement = iFrame;

    iFrame.src = URL.createObjectURL(iFrameBlob);
    iFrame.sandbox.add("allow-scripts", "allow-same-origin");

    iFrame.style.cssText = "position:absolute;left:0;top:-999px;width:1px;height:1px;";

    // appending early to have access to contentWindow
    const iFrameOnLoad = new Promise((resolve) => {
      iFrame.onload = () => {
        resolve();
      };
    });

    parentScope.body.appendChild(iFrame);

    try {
      await iFrameOnLoad;
    } catch (error) {
      console.error(error);
    }

    const iFrameWin = iFrame.contentWindow;
    // const iFrameDoc = iFrameWin.document;

    spnWorker = iFrameWin;
  }

  async initialize() {
    if (!spnWorker) {
      await this.initIframe();
      if (!spnWorker) {
        console.error("SPN FATAL: Couldn't create iFrame");
        return;
      }
    }

    const contextUid = `audioWorklet${UID}`;
    this.contextUid = contextUid;
    UID += 1;

    if (!proxyPort) {
      proxyPort = Comlink.wrap(Comlink.windowEndpoint(spnWorker));
    }

    if (!this.audioContext) {
      if (this.audioContextIsProvided) {
        log.error(`fatal: the provided AudioContext was undefined`);
      }
      this.audioContext = new (WebkitAudioContext())();
    }
    if (this.audioContext.state === "closed") {
      if (this.audioContextIsProvided) {
        log.error(`fatal: the provided AudioContext was closed, falling back new AudioContext`);
      }
      this.audioContext = new (WebkitAudioContext())();
    }

    // just set it both on parent and iframe
    // since 1 works on linux and other one on mac
    // leaking globals indeed
    spnWorker[contextUid] = this.audioContext;
    window[`__csound_wasm_iframe_parent_${contextUid}`] = this.audioContext;
    const { port1: mainMessagePort, port2: workerMessagePort } = new MessageChannel();

    await proxyPort.initialize(
      Comlink.transfer(
        {
          contextUid,
          hardwareBufferSize: 32768,
          softwareBufferSize: 2048,
          inputsCount: this.inputsCount,
          outputsCount: this.outputsCount,
          sampleRate: this.sampleRate,
          audioInputPort: this.ipcMessagePorts.audioWorkerAudioInputPort,
          messagePort: workerMessagePort,
          requestPort: this.ipcMessagePorts.audioWorkerFrameRequestPort,
          audioContextIsProvided: this.audioContextIsProvided,
          autoConnect: this.autoConnect,
          initialPlayState: this.currentPlayState,
        },
        [
          this.ipcMessagePorts.audioWorkerAudioInputPort,
          workerMessagePort,
          this.ipcMessagePorts.audioWorkerFrameRequestPort,
        ],
      ),
    );
    mainMessagePort.addEventListener("message", messageEventHandler(this));
    mainMessagePort.start();
    if (this.csoundWorkerMain && this.csoundWorkerMain.publicEvents) {
      const audioNode =
        spnWorker[`${contextUid}Node`] || window[`__csound_wasm_iframe_parent_${contextUid}Node`];

      if (
        audioNode &&
        this.csoundWorkerMain &&
        this.csoundWorkerMain.publicEvents &&
        this.csoundWorkerMain.publicEvents.triggerOnAudioNodeCreated
      ) {
        this.csoundWorkerMain.publicEvents.triggerOnAudioNodeCreated(audioNode);
      }
    }
  }
}

export default ScriptProcessorNodeMainThread;