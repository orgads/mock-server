/* eslint-disable no-sync */
/*
 * Copyright (C) 2020 AudioCodes Ltd.
 */

import * as Throttle from 'throttle';
import * as WebSocket from 'ws';
import * as core from 'express-serve-static-core';
import * as express from 'express';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as stream from 'stream';
import * as util from 'util';
import incrementalAverage from 'incremental-average';
const logger = console;
let statusCodeTimes = 0;
let statusCodeCounter = 0;
let statusCode = 200;
let delayTimes = 0;
let delayCounter = 0;
let delayMiliseconds = 0;
const sleep = util.promisify(setTimeout);

const app = express();
const commandsapp = express();
const port = 8043;
const commandsport = 8044;
const logSent = false;
const logReceived = false;

class MockWebSocket extends WebSocket {
  isAcApi: boolean;
}

class Stat {
  count = 0;
  errors = 0;
  length = incrementalAverage();
  [util.inspect.custom]() {
    if (!this.count)
      return 'None';
    let str = `${this.count} [${Math.floor(this.length.getAverage())}]`;
    if (this.errors)
      str += ` errors: ${this.errors}`;
    return str;
  }
}

class Stats {
  playing: Stat = new Stat();
  recording: Stat = new Stat();
}

interface Result {
  type: 'hypothesis' | 'recognition',
  text: string,
  confidence?: number
}

interface Scenario {
  [key: string]: Result;
}

let stats: Stats = new Stats();
let scenarioIdx = 0;

const defaultScenarios: Scenario[] = [{
  250: {
    type: 'hypothesis',
    text: 'This is a'
  },
  400: {
    type: 'hypothesis',
    text: 'This is a test'
  },
  500: {
    type: 'recognition',
    text: 'This is a test message',
    confidence: 0.96887113
  }
}];

let myScenarios = defaultScenarios;
let numberOfRepetition = 1;

setInterval(() => {
  if (!stats.playing.count && !stats.recording.count)
    return;
  logger.info(JSON.stringify(stats));
  stats = new Stats();
}, 1000);

commandsapp.post('/TTSStatusCode/:code/:times', (req, res) => {
  statusCodeCounter = 0;
  statusCode = Number(req.params.code);
  statusCodeTimes = Number(req.params.times);
  logger.debug(`will return status code ${statusCode} ${statusCodeTimes} times`);
  res.send(`will return status code ${statusCode} ${statusCodeTimes} times\n`);
});

commandsapp.post('/TTSDelay/:delayMiliseconds/:times', (req, res) => {
  delayCounter = 0;
  delayMiliseconds = Number(req.params.delayMiliseconds);
  delayTimes = Number(req.params.times);
  logger.debug(`will respond to TTS with ${delayMiliseconds} milisecond delay ${delayTimes} times`);
  res.send(`will respond to TTS with ${delayMiliseconds} milisecond delay ${delayTimes} times\n`);
});

app.post('/cognitiveservices/v1', (_req, res) => {
  ++stats.playing.count;
  const start = Date.now();
  const onEnd = (err: Error) => {
    if (err)
      ++stats.playing.errors;
    stats.playing.length.add(Date.now() - start);
  };
  const fileName = path.join(__dirname, 'test-message-16k.wav');
  if (statusCodeCounter < statusCodeTimes)
    res.status(statusCode);
  statusCodeCounter++;
  if (statusCodeCounter === statusCodeTimes)
    logger.debug(`finished returning status code ${statusCode} ${statusCodeTimes} times`);

  if (process.env.DEBUG_THROTTLE) {
    const file = fs.createReadStream(fileName);
    file.pipe(new Throttle(32000)).pipe(res);
    stream.finished(res, onEnd);
  } else {
    if (delayCounter < delayTimes)
      setTimeout(() => res.sendFile(fileName, onEnd), delayMiliseconds);
    else
      res.sendFile(fileName, onEnd);
    delayCounter++;
    if (delayCounter === delayTimes)
      logger.debug(`finished returning responding with ${delayMiliseconds} milisecond delay ${delayTimes} times`);
  }
});

interface ReqBody {
  repeat: number;
  scenarios: Scenario[];
}

app.use(express.json());
app.post('/Scenarios', (req: express.Request<core.ParamsDictionary, any, ReqBody>, res) => {
  logger.debug(`Got new Scenarios: ${JSON.stringify(req.body)}`);
  const request = req.body;
  numberOfRepetition = request.repeat || 1;
  scenarioIdx = 0;
  const scenarios = request.scenarios || request;
  if (!Array.isArray(scenarios)) {
    res.sendStatus(400);
    logger.error('Scenarios must be an array');
    return;
  }
  for (const scenario of scenarios) {
    let lastKey = 0;
    for (const key of Object.keys(scenario)) {
      if (scenario[key].type !== 'hypothesis' && scenario[key].type !== 'recognition') {
        res.sendStatus(400);
        logger.error(`unknown type: ${scenario[key].type}`);
        return;
      }
      if (Number(key) < lastKey) {
        res.status(400);
        const message = `Keys must be sorted in non-descending order. ${key} is less than ${lastKey}`;
        res.send(message);
        logger.error(message);
      }
      lastKey = Number(key);
    }
  }
  scenarioIdx = 0;
  myScenarios = scenarios.length > 0 ? scenarios : defaultScenarios;
  res.sendStatus(200);
});

const server = https.createServer({
  cert: fs.readFileSync(path.resolve(__dirname, 'cert.pem')),
  key: fs.readFileSync(path.resolve(__dirname, 'key.pem'))
}, app);

const send = (ws: MockWebSocket, str: string) => {
  const msg = str.replace(/\n/gu, '\r\n');
  if (logSent)
    logger.info('sending: ', msg);
  return new Promise<void>((resolve, reject) => ws.send(msg, {}, (err) => {
    if (err)
      reject(err);
    else
      resolve();
  }));
};

const parseMessage = (message: string) => {
  const parsedMessage: Record<string, string> = {};
  const lines = message.split('\r\n');
  let startBody = false;

  lines.forEach((element) => {
    const str = String(element);
    if (str.startsWith('{')) {
      startBody = true;
      parsedMessage.body = str;
    } else if (startBody) {
      parsedMessage.body += str;
    } else {
      const header = str.split(':');
      if (header.length === 2) {
        parsedMessage[header[0].trim().toLowerCase()] = header[1].trim();
      }
    }
  });
  return parsedMessage;
};

const sendHypothesis = (hypoObj: { text: string }, ws: MockWebSocket, requestId: string, offset: number) => {
  if (ws.isAcApi)
    return send(ws, `{
  "type": "hypothesis",
  "alternatives":
  [
    { "text": "${hypoObj.text.toLowerCase()}" }
  ]
}`);
  return send(ws, `X-RequestId:${requestId}
Content-Type:application/json; charset=utf-8
Path:speech.hypothesis

{"Text":"${hypoObj.text.toLowerCase()}","Offset":${offset},"Duration":2500000}`);
};

const sendRecognition = (recObj: Result, ws: MockWebSocket, requestId: string, offset: number) => {
  if (ws.isAcApi)
    return send(ws, `{
  "type": "recognition",
  "alternatives":
  [
    { "text": "${recObj.text.toLowerCase()}", "confidence": 0.8355 }
  ]
}`);
  return send(ws, `X-RequestId:${requestId}
Content-Type:application/json; charset=utf-8
Path:speech.phrase

{"RecognitionStatus":"Success",\
"Offset":${offset},\
"Duration":13300000,\
"NBest":[{"Confidence":${recObj.confidence || 0.96850842237472534},\
"Lexical":"${recObj.text.toLowerCase()}",\
"ITN":"${recObj.text}",\
"MaskedITN":"${recObj.text}",\
"Display":"${recObj.text}."},\
{"Confidence":0.90522688627243042,\
"Lexical":"oh ${recObj.text.toLowerCase()}",\
"ITN":"oh ${recObj.text.toLowerCase()}",\
"MaskedITN":"oh ${recObj.text.toLowerCase()}",\
"Display":"oh ${recObj.text.toLowerCase()}"},\
{"Confidence":${recObj.confidence || 0.948},\
"Lexical":"uh ${recObj.text.toLowerCase()}",\
"ITN":"uh ${recObj.text.toLowerCase()}",\
"MaskedITN":"uh ${recObj.text.toLowerCase()}",\
"Display":"uh ${recObj.text.toLowerCase()}"}]}`);
};

const onMessage = async (ws: MockWebSocket, message: string, scenario: Scenario) => {
  const msg = parseMessage(message);
  const requestId: string = msg['x-requestid'];
  if (ws.isAcApi) {
    if (message.startsWith('{'))
    {
      const acApiMsg = JSON.parse(message);
      switch (acApiMsg.type) {
        case 'start':
          await send(ws, `{
  "type": "started"
}`);
          await sleep(50);
          break;
        case 'stop':
          await send(ws, `{
  "type": "end",
  "reason": "stop by client"
}`);
          scenarioIdx = -1;
          break;
        case 'end':
          await send(ws, `{
  "type": "end",
  "reason": "ended by client"
}`);
          scenarioIdx = -1;
          await sleep(50);
          ws.isAcApi = false;
          ws.close();
          return;

        default:
          break;
      }
    }
  }
  else {
    await send(ws, `X-RequestId:${requestId}
Content-Type:application/json; charset=utf-8
Path:turn.start

{
  "context": {
    "serviceTag": "ce63ffcb858045339f42bc31c489e53b"
  }
}`);

    await send(ws, `X-RequestId:${requestId}
Content-Type:application/json; charset=utf-8
Path:speech.startDetected

{"Offset":500000}`);
  }
  let seq = 0;
  let offset = 500000;
  const scenarioKeys = Object.keys(scenario).map((key) => parseInt(key, 10));
  let lastKey = 0;
  for (const key of scenarioKeys) {
    offset = 500000 + (seq * 20500000);
    const obj = scenario[key];
    const sender = obj.type === 'hypothesis' ? sendHypothesis : sendRecognition;
    // eslint-disable-next-line no-await-in-loop
    await sleep(key - lastKey);
    // eslint-disable-next-line no-await-in-loop
    await sender(obj, ws, requestId, offset);
    lastKey = key;
    seq++;
  }
  if (ws.isAcApi)
    return;

  await send(ws, `X-RequestId:${requestId}
Content-Type:application/json; charset=utf-8
Path:speech.endDetected

{"Offset":${offset}}`);

  await send(ws, `X-RequestId:${requestId}
Content-Type:application/json; charset=utf-8
Path:speech.phrase

{"RecognitionStatus":"EndOfDictation","Offset":${offset},"Duration":0}`);

  await send(ws, `X-RequestId:${requestId}
Content-Type:application/json; charset=utf-8
Path:turn.end

{}`);

  await sleep(50);
  ws.isAcApi = false;
  ws.close();
};

const createWSServer = () => new MockWebSocket.Server({
  perMessageDeflate: {
    clientNoContextTakeover: true,
    concurrencyLimit: 10,
    serverMaxWindowBits: 10,
    serverNoContextTakeover: true,
    threshold: 1024,
    zlibDeflateOptions: {
      // See zlib defaults.
      chunkSize: 1024,
      level: 3,
      memLevel: 7
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    }
  },
  server
});

const nextScenario = () => {
  if (numberOfRepetition > 0) {
    scenarioIdx = (scenarioIdx + 1) % myScenarios.length;
    if (scenarioIdx === 0)
      --numberOfRepetition;
  }
  if (numberOfRepetition <= 0)
    scenarioIdx = -1;
};

const registerConnection = (webSockServer: WebSocket.Server) => {
  webSockServer.on('connection', (ws: MockWebSocket) => {
    ++stats.recording.count;
    let first = true;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    ws.on('message', async (message) => {
      const isBuf = Buffer.isBuffer(message);
      const msgStr = message.toString();
      if (logReceived) {
        if (isBuf)
          logger.info('received: ---binary data--- length:', msgStr.length);
        else
          logger.info('received:', msgStr);
      }
      if (!isBuf && msgStr.startsWith('{')) {
        const msgJson = JSON.parse(msgStr);
        if (msgJson.type === 'start') {
          ws.isAcApi = true;
          scenarioIdx = 0;
        }
      }
      if ((!ws.isAcApi && !first) || scenarioIdx === -1)
        return;
      first = false;
      const start = Date.now();
      try {
        const scenario = scenarioIdx < myScenarios.length ? myScenarios[scenarioIdx] : {};
        await onMessage(ws, message.toString(), scenario);
      } catch (err) {
        logger.error(err);
      }
      nextScenario();
      stats.recording.length.add(Date.now() - start);
    });
  });
};

let wss = createWSServer();
registerConnection(wss);

commandsapp.post('/DisableSTT/:timeMiliseconds', (req, res) => {
  const timeMiliseconds = Number(req.params.timeMiliseconds);
  logger.debug(`will close STT server for ${timeMiliseconds} miliseconds`);
  res.send(`will close STT server for ${timeMiliseconds} miliseconds\n`);
  wss.close();
  setTimeout(() => {
    wss = createWSServer();
    registerConnection(wss);
    logger.debug(`restarted STT server after ${timeMiliseconds} miliseconds`);
  }, timeMiliseconds);
});

server.listen(port, '0.0.0.0', () => logger.info(`Server listening on ${port}.`));
commandsapp.listen(commandsport, '0.0.0.0', () => logger.info(`commands listening on ${commandsport}.`));
