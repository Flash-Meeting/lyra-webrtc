'use strict';

import Module from './webassembly_codec_wrapper.js';

let codecModule;
Module().then((module) => {
  console.log("Initialized codec's wasmModule.");
  codecModule = module;
}).catch(e => {
  console.log(`Module() error: ${e.name} message: ${e.message}`);
});

const startButton = document.getElementById('startButton');
const codecSelect = document.getElementById('codecSelect');
const callButton = document.getElementById('callButton');
const hangupButton = document.getElementById('hangupButton');
const audioOutput = document.getElementById('audioOutput');
const bitrateSpan = document.getElementById('bitrateSpan');
const historyTBody = document.getElementById('historyTBody');

startButton.onclick = start;
callButton.onclick = call;
hangupButton.onclick = hangup;

let localStream;
let pc1;
let pc2;

let historyIndex = 0;
let initialTimestamp;
let maxBitrate;
let minBitrate;
let lastTimestamp;
let lastBytesSent;
let interval;

async function start() {
  startButton.disabled = true;
  navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000 },
    video: false
  }).then((stream) => {
    callButton.disabled = false;
    localStream = stream;
  });
}

async function call() {
  codecSelect.disabled = true;
  callButton.disabled = true;
  hangupButton.disabled = false;

  initialTimestamp = 0;
  maxBitrate = 0;
  minBitrate = 1000000000;
  lastTimestamp = null;
  lastBytesSent = null;

  const useLyra = codecSelect.value === "lyra";
  pc1 = new RTCPeerConnection({ encodedInsertableStreams: useLyra });
  pc2 = new RTCPeerConnection({ encodedInsertableStreams: useLyra });
  pc1.onicecandidate = (e) => {
    pc2.addIceCandidate(e.candidate)
  };
  pc2.onicecandidate = (e) => {
    pc1.addIceCandidate(e.candidate)
  };
  pc2.ontrack = (e) => {
    if (audioOutput.srcObject === e.streams[0]) {
      return;
    }
    if (useLyra) {
      const receiver = e.receiver;
      const receiverStreams = receiver.createEncodedStreams();
      const transformStream = new TransformStream({
        transform: decodeFunction,
      });
      receiverStreams.readable
          .pipeThrough(transformStream)
          .pipeTo(receiverStreams.writable);
    }
    audioOutput.srcObject = e.streams[0];
  };
  localStream.getTracks().forEach(track => pc1.addTrack(track, localStream));
  if (useLyra) {
    const sender = pc1.getSenders()[0];
    const senderStreams = sender.createEncodedStreams();
    const transformStream = new TransformStream({
      transform: encodeFunction,
    });
    senderStreams.readable
        .pipeThrough(transformStream)
        .pipeTo(senderStreams.writable);
  } else if (codecSelect.value !== "pcm") {
    const preferredCodecMimeType = codecSelect.value === "opus" ? "audio/opus" : "audio/PCMA";
    const { codecs } = RTCRtpSender.getCapabilities('audio');
    const preferredCodecIndex = codecs.findIndex(c => c.mimeType === preferredCodecMimeType);
    const preferredCodec = codecs[preferredCodecIndex];
    codecs.splice(preferredCodecIndex, 1);
    codecs.unshift(preferredCodec);
    const transceiver = pc1.getTransceivers().find(t => t.sender && t.sender.track === localStream.getAudioTracks()[0]);
    transceiver.setCodecPreferences(codecs);
  }
  pc1.createOffer().then((offer) => {
   const modifiedOffer = modifyDesc(offer);
    pc1.setLocalDescription(modifiedOffer).then(() => {
      return pc2.setRemoteDescription(modifiedOffer);
    }).then(() => {
     return pc2.createAnswer();
    }).then((answer) => {
      const modifiedAnswer = modifyDesc(answer);
      pc2.setLocalDescription(modifiedAnswer).then(() => {
        pc1.setRemoteDescription(modifiedAnswer);
      });
    });
  });
  interval = setInterval(updateStat, 1000);
}

async function hangup() {
  clearInterval(interval);
  pc1.close();
  pc2.close();
  pc1 = null;
  pc2 = null;

  bitrateSpan.innerText = "";

  const time = (lastTimestamp - initialTimestamp) / 1000.0;
  if (time > 3) {
    const tr = document.createElement("tr");
    appendTD(tr, historyIndex++);
    appendTD(tr, codecSelect.options[codecSelect.selectedIndex].text);
    appendTD(tr, (maxBitrate / 1000).toFixed());
    appendTD(tr, (minBitrate / 1000).toFixed());
    const average = lastBytesSent * 8 / time;
    appendTD(tr, (average / 1000).toFixed());
    appendTD(tr, time.toFixed());
    historyTBody.appendChild(tr);
  }

  hangupButton.disabled = true;
  callButton.disabled = false;
  codecSelect.disabled = false;
}

function appendTD(tr, text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}

function modifyDesc(desc) {
  let modifiedSDP = desc.sdp;
  if (codecSelect.value === "lyra" || codecSelect.value === "pcm") {
    modifiedSDP = addL16ToSDP(modifiedSDP);
  }
  if (codecSelect.value === "lyra") {
    modifiedSDP = removeCNFromSDP(modifiedSDP);
  }
  return {
    type: desc.type,
    sdp: modifiedSDP
  }
}

function addL16ToSDP(sdp) {
  return sdp
     .replace("SAVPF 111", "SAVPF 109 111")
     .replace("a=rtpmap:111", "a=rtpmap:109 L16/16000/1\r\na=fmtp:109 ptime=20\r\na=rtpmap:111");
}

function removeCNFromSDP(sdp) {
  return sdp
     .replace("a=rtpmap:106 CN/32000\r\n", "")
     .replace("a=rtpmap:105 CN/16000\r\n", "")
     .replace("a=rtpmap:13 CN/8000\r\n", "")
     .replace(" 106 105 13", "");
}

function encodeFunction(encodedFrame, controller) {
  const inputDataArray = new Uint8Array(encodedFrame.data);

  const inputBufferPtr = codecModule._malloc(encodedFrame.data.byteLength);
  const encodedBufferPtr = codecModule._malloc(1024);

  codecModule.HEAPU8.set(inputDataArray, inputBufferPtr);
  const length = codecModule.encode(inputBufferPtr,
      inputDataArray.length, 16000,
      encodedBufferPtr);

  const newData = new ArrayBuffer(length);
  if (length > 0) {
    const newDataArray = new Uint8Array(newData);
    newDataArray.set(codecModule.HEAPU8.subarray(encodedBufferPtr, encodedBufferPtr + length));
  }

  codecModule._free(inputBufferPtr);
  codecModule._free(encodedBufferPtr);

  encodedFrame.data = newData;
  controller.enqueue(encodedFrame);
}

function decodeFunction(encodedFrame, controller) {
  const newData = new ArrayBuffer(16000 * 0.02 * 2);
  if (encodedFrame.data.byteLength > 0) {
    const inputDataArray = new Uint8Array(encodedFrame.data);
    const inputBufferPtr = codecModule._malloc(encodedFrame.data.byteLength);
    const outputBufferPtr = codecModule._malloc(2048);
    codecModule.HEAPU8.set(inputDataArray, inputBufferPtr);
    const length = codecModule.decode(inputBufferPtr,
        inputDataArray.length, 16000,
        outputBufferPtr);
  
    const newDataArray = new Uint8Array(newData);
    newDataArray.set(codecModule.HEAPU8.subarray(outputBufferPtr, outputBufferPtr + length));
  
    codecModule._free(inputBufferPtr);
    codecModule._free(outputBufferPtr);
  }

  encodedFrame.data = newData;
  controller.enqueue(encodedFrame);
}

function updateStat() {
  let mediaSourceId;
  pc1.getStats().then((stats) => {
    stats.forEach((stat) => {
      if (stat.type === "track") {
        mediaSourceId = stat.mediaSourceId;
      } else if (stat.type === "outbound-rtp" && stat.mediaSourceId === mediaSourceId) {
        const timestamp = stat.timestamp;
        const bytesSent = stat.bytesSent;
        if (lastTimestamp && lastBytesSent) {
          const bitrate = (bytesSent - lastBytesSent) * 8 / ((timestamp - lastTimestamp) / 1000.0);
          if (bitrate < minBitrate) {
            minBitrate = bitrate;
          }
          if (bitrate > maxBitrate) {
            maxBitrate = bitrate;
          }
          bitrateSpan.innerText =
              `time: ${((timestamp - initialTimestamp) / 1000.0).toFixed()} s ` +
              `bitrate: ${(bitrate / 1000).toFixed()} kbit/s`;
        }
        if (initialTimestamp === 0) {
          initialTimestamp = timestamp;
        }
        lastTimestamp = timestamp;
        lastBytesSent = bytesSent;
      }
    });
  });
}