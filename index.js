#!/usr/bin/env node 

const config = require("./config");

const suncalc = require("suncalc");
const moment = require("moment"), twix = require("twix");

const mqtt_client = require("mqtt");
const tradfri_client = require("node-tradfri-client").TradfriClient;
const tradfri_accessory = require("node-tradfri-client").Accessory;
const tradfri_accessory_types = require("node-tradfri-client").AccessoryTypes;

// Globals containing device states
const groups = {}, devices = {}; 
const tradfri_groups_by_name = {}, tradfri_groups_by_id = {};
const tradfri_devices_by_name = {}, tradfri_devices_by_id = {};

// Connect to services
const mqtt = mqtt_client.connect(config.mqtt.url), tradfri = new tradfri_client(config.tradfri.hostname);

// Check if time range contains now
async function time_range_contains({start, end, now}) {
    const moment_start = moment(start), moment_end = moment(end), moment_now = moment(now);
    if(moment_now.isAfter(moment_end) && moment_end.isBefore(moment_start)) {
        moment_end.add(1, 'day');
    } else if (moment_now.isBefore(moment_end) && moment_start.isAfter(moment_end)) {
        moment_start.subtract(1, 'day');
    }
    return moment.twix(moment_start, moment_end).contains(moment_now);
}

// Get lights from specified group
const group_lights_get = (groupname) => groups[groupname].devices.map((name) => devices[name]).filter((device) => device.type === 'light');

// Automatically turn off lights of specified group after x seconds
async function group_lights_off_timer_reschedule({groupname, seconds}) {
  const group_lights = group_lights_get(groupname); 
  if(group_lights.some((device) => device.on === true)) {
    console.log(`rescheduling '${groupname}' lights off in '${String(seconds)}' seconds`);
    clearTimeout(groups[groupname].timeout); groups[groupname].timeout = setTimeout(async function() {
      console.log(`turning off '${groupname}' lights`);
      try {
        await Promise.all(group_lights.map((device) => tradfri_devices_by_name[device.name]).map((device) => tradfri.operateLight(device, {onOff: false})));
      } catch(e) {
        console.log(`could not turn off lights: ${e.message}`);
        console.error(e.stack);
      }
    }, 1000 * seconds);
  }
}

// Turn on lights of specified group only if none of the lights in the group changed its state in the last 5 seconds (to prevent motion detection to turn on the lights when manually toggled)
async function group_lights_auto_on({groupname}) {
  const now = new Date();
  const group_lights = group_lights_get(groupname);
  const times = suncalc.getTimes(now, config.latitude, config.longitude);
  if(time_range_contains({start: times.goldenHour, end: times.sunriseEnd, now})) {
    if(group_lights.every((device) => device.on === false)) {
      if(group_lights.every((device) => (new Date() - device.updated) > (5 * 1000))) {
        console.log(`turning on '${groupname}' lights`);
        try {
          await Promise.all(group_lights.map((device) => tradfri_devices_by_name[device.name]).map((device) => tradfri.operateLight(device, {onOff: true})));
        } catch(e) {
          console.log(`could not turn on lights: ${e.message}`);
          console.error(e.stack);
        }
      }
    }
  }
}

// Automation main
async function automation() {

  // Connect to tradfri gateway
  await tradfri.connect(config.tradfri.identity, config.tradfri.psk);

  // Retrieve and monitor all tradfri device states
  tradfri.on("device updated", async function(device) {
    console.log(`updating '${device.name}' device state`);
    try {
      tradfri_devices_by_name[device.name] = tradfri_devices_by_id[device.instanceId] = device;
      if(device.type === tradfri_accessory_types.lightbulb) { 
        devices[device.name] = {name: device.name, updated: new Date(), type: 'light', on: device.lightList.every((light) => light.onOff === true)};
      } else {
        devices[device.name] = {name: device.name, updated: new Date(), type: 'unknown'};
      }
    } catch(e) {
      console.log(`could not update device state: ${e.message}`);
      console.error(e.stack);
    }
  }).on("device removed", (device) => {
    console.log(`removing '${device.name}' device`);
    Reflect.deleteProperty(tradfri_devices, device.name);
    Reflect.deleteProperty(devices, device.name);
  }).observeDevices();

  // Retrieve and monitor all tradfri group states
  tradfri.on("group updated", async function(group) {
    console.log(`updating '${group.name}' group state`);
    try {
      tradfri_groups_by_name[group.name] = tradfri_groups_by_id[group.instanceId] = group;
      groups[group.name] = {name: group.name, updated: new Date(), devices: group.deviceIDs.map((id) => tradfri_devices_by_id[id].name)};
    } catch(e) {
      console.log(`could not update group state: ${e.message}`);
      console.error(e.stack);
    }
  }).on("group removed", (group) => {
    console.log(`removing '${group.name}' group`);
    Reflect.deleteProperty(tradfri_groups, group.name);
    Reflect.deleteProperty(groups, group.name);
  }).observeGroupsAndScenes();

  // Listen for messaged on subscribed topics
  mqtt.on('message', async function(topic, message) {
    switch(topic) {

      // Living room camera event?
      case config.living_room.camera.topic:
      {
        // If motion or sound? 
        if(message.includes('MOTION') || message.includes('SOUND')) {
          // Reschedule lights to turn off after 5 minutes
          await group_lights_off_timer_reschedule({groupname: config.living_room.name, seconds: 60 * 5});
        }

        // If motion?
        if(message.includes('MOTION')) {
          // Turn on lights
          await group_lights_auto_on({groupname: config.living_room.name});
        }
      }
      break;

    }
  });

}

// Connect to mqtt broker and subscribe to specified topics
mqtt.on('connect', () => {
  for(const subscription of config.mqtt.subscriptions) {
    mqtt.subscribe(subscription);
  }
});

// Run automation
automation().catch((error) => {
  console.error(error);
});
