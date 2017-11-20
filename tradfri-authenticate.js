#!/usr/bin/env node 

const fs = require('fs');
const readline = require('readline');

const config = require("./config");

const tradfri_client = require("node-tradfri-client").TradfriClient;
const tradfri_accessory = require("node-tradfri-client").Accessory;
const tradfri_accessory_types = require("node-tradfri-client").AccessoryTypes;

const rl = readline.createInterface({input: process.stdin, output: process.stdout});

const readline_question_promise = (question) => new Promise((resolve) => rl.question(question, (answer) => resolve(answer)));
const write_file_promise = (filename, content) => new Promise((resolve, reject) => fs.writeFile(filename, content, (error) => (!error) ? resolve() : reject(error)));

async function tradfri_authenticate() {
  try {
    const hostname = await readline_question_promise('Enter Tradfri gateway hostname: ');
    const tradfri = new tradfri_client(hostname);
    const securitycode = await readline_question_promise('Enter 16 character Tradfri security code: ');
    if(securitycode.match(/^[a-zA-Z0-9]{16}$/)) {
      const {identity, psk} = await tradfri.authenticate(securitycode);
      await write_file_promise("./config.json", JSON.stringify(Object.assign(config, {"tradfri": {hostname, identity, psk}}), null, 2));
    } else {
      console.log('Invalid Tradfri security code');
    }
    tradfri.destroy();
  } catch (e) {
    console.error(e.message);
    console.error(e.stack);
  }
}

tradfri_authenticate().catch((e) => {
  console.error(e.message);
}).then(() => {
  rl.close();
});
