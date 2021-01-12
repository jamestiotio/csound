/*
    CsoundScriptProcessor.js

    Copyright (C) 2018 Steven Yi, Victor Lazzarini

    This file is part of Csound.

    The Csound Library is free software; you can redistribute it
    and/or modify it under the terms of the GNU Lesser General Public
    License as published by the Free Software Foundation; either
    version 2.1 of the License, or (at your option) any later version.

    Csound is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Lesser General Public License for more details.

    You should have received a copy of the GNU Lesser General Public
    License along with Csound; if not, write to the Free Software
    Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
    02110-1301 USA
*/

import libcsoundFactory from "@root/libcsound";
import loadWasm from "@root/module";
import MessagePortState from "@utils/message-port-state";
import { initFS, writeToFs, lsFs, llFs, readFromFs, rmrfFs } from "@root/filesystem";
import { isEmpty } from "ramda";
import { csoundApiRename, fetchPlugins, makeSingleThreadCallback } from "@root/utils";
import { messageEventHandler } from "./messages.main";
import { PublicEventAPI } from "@root/events";

class ScriptProcessorNodeSingleThread {
  constructor({ audioContext, inputChannelCount = 1, outputChannelCount = 2 }) {
    this.publicEvents = new PublicEventAPI(this);
    this.audioContext = audioContext;
    this.onaudioprocess = this.onaudioprocess.bind(this);
    this.currentPlayState = undefined;
    this.onPlayStateChange = this.onPlayStateChange.bind(this);
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
    this.pause = this.pause.bind(this);
    this.resume = this.resume.bind(this);
    this.wasm = undefined;
    this.csoundInstance = undefined;
    this.csoundApi = undefined;
    this.exportApi = {};
    this.spn = audioContext.createScriptProcessor(0, inputChannelCount, outputChannelCount);
    this.spn.audioContext = audioContext;
    this.spn.inputChannelCount = inputChannelCount;
    this.spn.outputChannelCount = outputChannelCount;
    this.spn.onaudioprocess = this.onaudioprocess;
    this.node = this.spn;
    this.exportApi.getNode = async () => this.spn;
    this.sampleRate = audioContext.sampleRate;
    // this is the only actual single-thread usecase
    // so we get away with just forwarding it as if it's form
    // a message port
    this.messagePort = new MessagePortState();
    this.messagePort.post = (log) => messageEventHandler(this)({ data: { log } });
    this.messagePort.ready = true;

    // imports from original csound-wasm
    this.running = false;
    this.started = false;
  }

  async terminateInstance() {
    if (this.spn) {
      this.spn.disconnect();
      delete this.spn;
    }
    if (this.audioContext) {
      if (this.audioContext.state !== "closed") {
        await this.audioContext.close();
      }
      delete this.audioContext;
    }
    if (this.publicEvents) {
      this.publicEvents.terminateInstance();
      delete this.publicEvents;
    }
    Object.keys(this.exportApi).forEach((key) => delete this.exportApi[key]);
    Object.keys(this).forEach((key) => delete this[key]);
  }

  async onPlayStateChange(newPlayState) {
    if (this.currentPlayState === newPlayState) {
      return;
    }
    this.currentPlayState = newPlayState;
    switch (newPlayState) {
      case "realtimePerformanceStarted": {
        this.publicEvents.triggerRealtimePerformanceStarted(this);
        break;
      }

      case "realtimePerformanceEnded": {
        this.publicEvents.triggerRealtimePerformanceEnded(this);
        break;
      }
      case "realtimePerformancePaused": {
        this.publicEvents.triggerRealtimePerformancePaused(this);
        break;
      }
      case "realtimePerformanceResumed": {
        this.publicEvents.triggerRealtimePerformanceResumed(this);
        break;
      }
      case "renderStarted": {
        this.publicEvents.triggerRenderStarted(this);
        break;
      }
      case "renderEnded": {
        this.publicEvents.triggerRenderEnded(this);
        break;
      }

      default: {
        break;
      }
    }
  }

  async pause() {
    if (this.started && this.running) {
      this.running = false;
      this.onPlayStateChange("realtimePerformancePaused");
    }
  }

  async resume() {
    if (this.started && !this.running) {
      this.running = true;
      this.onPlayStateChange("realtimePerformanceResumed");
    }
  }

  async stop() {
    if (this.started) {
      const stopPromise = new Promise((resolve) => {
        this.stopPromiz = resolve;
      });
      const stopResult = this.csoundApi.csoundStop(this.csoundInstance);
      await stopPromise;
      if (this.watcherStdOut) {
        this.watcherStdOut.close();
        delete this.watcherStdOut;
      }

      if (this.watcherStdErr) {
        this.watcherStdErr.close();
        delete this.watcherStdErr;
      }

      delete this.csoundInputBuffer;
      delete this.csoundOutputBuffer;
      delete this.currentPlayState;
      return stopResult;
    }
  }

  async start() {
    if (!this.csoundApi) {
      console.error("starting csound failed because csound instance wasn't created");
      return undefined;
    }

    if (this.currentPlayState !== "realtimePerformanceStarted") {
      this.result = 0;
      this.csoundApi.csoundSetOption(this.csoundInstance, "-odac");
      this.csoundApi.csoundSetOption(this.csoundInstance, "-iadc");
      this.csoundApi.csoundSetOption(this.csoundInstance, "--sample-rate=" + this.sampleRate);
      this.nchnls = -1;
      this.nchnls_i = -1;

      const ksmps = this.csoundApi.csoundGetKsmps(this.csoundInstance);
      this.ksmps = ksmps;
      this.cnt = ksmps;

      this.nchnls = this.csoundApi.csoundGetNchnls(this.csoundInstance);
      this.nchnls_i = this.csoundApi.csoundGetNchnlsInput(this.csoundInstance);

      const outputPointer = this.csoundApi.csoundGetSpout(this.csoundInstance);
      this.csoundOutputBuffer = new Float64Array(
        this.wasm.exports.memory.buffer,
        outputPointer,
        ksmps * this.nchnls,
      );

      const inputPointer = this.csoundApi.csoundGetSpin(this.csoundInstance);
      this.csoundInputBuffer = new Float64Array(
        this.wasm.exports.memory.buffer,
        inputPointer,
        ksmps * this.nchnls_i,
      );
      this.zerodBFS = this.csoundApi.csoundGet0dBFS(this.csoundInstance);

      this.publicEvents.triggerOnAudioNodeCreated(this.spn);
      const startPromise = new Promise((resolve) => {
        this.startPromiz = resolve;
      });
      if (!this.watcherStdOut && !this.watcherStdErr) {
        [this.watcherStdOut, this.watcherStdErr] = initFS(this.wasmFs, this.messagePort);
      }
      const startResult = this.csoundApi.csoundStart(this.csoundInstance);
      this.running = true;
      await startPromise;
      return startResult;
    }
  }

  async initialize({ wasmDataURI, withPlugins, autoConnect }) {
    if (!this.plugins && withPlugins && !isEmpty(withPlugins)) {
      withPlugins = await fetchPlugins(withPlugins);
    }

    if (!this.wasm) {
      [this.wasm, this.wasmFs] = await loadWasm({
        wasmDataURI,
        withPlugins,
        messagePort: this.messagePort,
      });
      [this.watcherStdOut, this.watcherStdErr] = initFS(this.wasmFs, this.messagePort);
    }

    // libcsound
    const csoundApi = libcsoundFactory(this.wasm);
    this.csoundApi = csoundApi;
    const csoundInstance = await csoundApi.csoundCreate(0);
    this.csoundInstance = csoundInstance;

    if (autoConnect) {
      this.spn.connect(this.audioContext.destination);
    }

    this.resetCsound(false);

    // csoundObj
    Object.keys(csoundApi).reduce((acc, apiName) => {
      const renamedApiName = csoundApiRename(apiName);
      acc[renamedApiName] = makeSingleThreadCallback(csoundInstance, csoundApi[apiName]);
      return acc;
    }, this.exportApi);

    this.exportApi.pause = this.pause.bind(this);
    this.exportApi.resume = this.resume.bind(this);
    this.exportApi.start = this.start.bind(this);
    this.exportApi.stop = this.stop.bind(this);
    this.exportApi.reset = () => this.resetCsound(true);
    this.exportApi.terminateInstance = this.terminateInstance.bind(this);
    this.exportApi.getAudioContext = async () => this.audioContext;
    this.exportApi.name = "Csound: ScriptProcessor Node, Single-threaded";

    // filesystem export
    this.exportApi.writeToFs = writeToFs(this.wasmFs);
    this.exportApi.lsFs = lsFs(this.wasmFs);
    this.exportApi.readFromFs = readFromFs(this.wasmFs);
    this.exportApi.rmrfFs = rmrfFs(this.wasmFs);
    this.exportApi = this.publicEvents.decorateAPI(this.exportApi);
    // the default message listener
    this.exportApi.addListener("message", console.log);
    return this.exportApi;
  }

  async resetCsound(callReset) {
    if (
      this.currentPlayState !== "realtimePerformanceEnded" &&
      this.currentPlayState !== "realtimePerformanceStarted"
    ) {
      // reset can't be called until performance has started or ended!
      return -1;
    }
    if (this.currentPlayState === "realtimePerformanceStarted") {
      this.onPlayStateChange("realtimePerformanceEnded");
    }

    this.running = false;
    this.started = false;
    this.result = 0;

    let cs = this.csoundInstance;
    let libraryCsound = this.csoundApi;

    if (callReset) {
      libraryCsound.csoundReset(cs);
    }

    // FIXME:
    // libraryCsound.csoundSetMidiCallbacks(cs);
    if (!this.watcherStdOut && !this.watcherStdErr) {
      [this.watcherStdOut, this.watcherStdErr] = initFS(this.wasmFs, this.messagePort);
    }

    libraryCsound.csoundSetOption(cs, "-odac");
    libraryCsound.csoundSetOption(cs, "-iadc");
    libraryCsound.csoundSetOption(cs, "--sample-rate=" + this.sampleRate);
    this.nchnls = -1;
    this.nchnls_i = -1;
    this.csoundOutputBuffer = null;
  }

  onaudioprocess(e) {
    if (this.csoundOutputBuffer === null || this.running === false) {
      const output = e.outputBuffer;
      const bufferLen = output.getChannelData(0).length;

      for (let i = 0; i < bufferLen; i++) {
        for (let channel = 0; channel < output.numberOfChannels; channel++) {
          const outputChannel = output.getChannelData(channel);
          outputChannel[i] = 0;
        }
      }
      return;
    }

    if (this.running && !this.started) {
      this.started = true;
      this.onPlayStateChange("realtimePerformanceStarted");
      if (this.startPromiz) {
        this.startPromiz();
        delete this.startPromiz;
      }
    }

    const input = e.inputBuffer;
    const output = e.outputBuffer;

    const bufferLen = output.getChannelData(0).length;

    let csOut = this.csoundOutputBuffer;
    let csIn = this.csoundInputBuffer;

    const ksmps = this.ksmps;
    const zerodBFS = this.zerodBFS;

    const nchnls = this.nchnls;
    const nchnls_i = this.nchnls_i;

    let cnt = this.cnt || 0;
    let result = this.result || 0;

    for (let i = 0; i < bufferLen; i++, cnt++) {
      if (cnt == ksmps && result == 0) {
        // if we need more samples from Csound
        result = this.csoundApi.csoundPerformKsmps(this.csoundInstance);
        cnt = 0;
        if (result != 0) {
          this.running = false;
          this.started = false;
          this.onPlayStateChange("realtimePerformanceEnded");
          if (this.stopPromiz) {
            this.stopPromiz();
            delete this.stopPromiz;
          }
        }
      }

      /* Check if MEMGROWTH occured from csoundPerformKsmps or otherwise. If so,
      rest output ant input buffers to new pointer locations. */
      if (csOut.length === 0) {
        csOut = this.csoundOutputBuffer = new Float64Array(
          this.wasm.exports.memory.buffer,
          this.csoundApi.csoundGetSpout(this.csoundInstance),
          ksmps * nchnls,
        );
      }

      if (csIn.length === 0) {
        csIn = this.csoundInputBuffer = new Float64Array(
          this.wasm.exports.memory.buffer,
          this.csoundApi.csoundGetSpin(this.csoundInstance),
          ksmps * nchnls_i,
        );
      }

      // handle 1->1, 1->2, 2->1, 2->2 input channel count mixing and nchnls_i
      const inputChanMax = Math.min(this.nchnls_i, input.numberOfChannels);
      for (let channel = 0; channel < inputChanMax; channel++) {
        const inputChannel = input.getChannelData(channel);
        csIn[cnt * nchnls_i + channel] = inputChannel[i] * zerodBFS;
      }

      // Output Channel mixing matches behavior of:
      // https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Basic_concepts_behind_Web_Audio_API#Up-mixing_and_down-mixing

      // handle 1->1, 1->2, 2->1, 2->2 output channel count mixing and nchnls
      if (this.nchnls == output.numberOfChannels) {
        for (let channel = 0; channel < output.numberOfChannels; channel++) {
          const outputChannel = output.getChannelData(channel);
          if (result == 0) outputChannel[i] = csOut[cnt * nchnls + channel] / zerodBFS;
          else outputChannel[i] = 0;
        }
      } else if (this.nchnls == 2 && output.numberOfChannels == 1) {
        const outputChannel = output.getChannelData(0);
        if (result == 0) {
          const left = csOut[cnt * nchnls] / zerodBFS;
          const right = csOut[cnt * nchnls + 1] / zerodBFS;
          outputChannel[i] = 0.5 * (left + right);
        } else {
          outputChannel[i] = 0;
        }
      } else if (this.nchnls == 1 && output.numberOfChannels == 2) {
        const outChan0 = output.getChannelData(0);
        const outChan1 = output.getChannelData(1);

        if (result == 0) {
          const val = csOut[cnt * nchnls] / zerodBFS;
          outChan0[i] = val;
          outChan1[i] = val;
        } else {
          outChan0[i] = 0;
          outChan1[i] = 0;
        }
      } else {
        // FIXME: we do not support other cases at this time
      }

      // for (let channel = 0; channel < input.numberOfChannels; channel++) {
      //   const inputChannel = input.getChannelData(channel);
      //   csIn[cnt * nchnls_i + channel] = inputChannel[i] * zerodBFS;
      // }
      // for (let channel = 0; channel < output.numberOfChannels; channel++) {
      //   const outputChannel = output.getChannelData(channel);
      //   if (result == 0) outputChannel[i] = csOut[cnt * nchnls + channel] / zerodBFS;
      //   else outputChannel[i] = 0;
      // }
    }

    this.cnt = cnt;
    this.result = result;
  }
}

export default ScriptProcessorNodeSingleThread;