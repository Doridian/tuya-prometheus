const TuyaCloud = require('@tuyapi/cloud');
const prom = require('prom-client');
const http = require('http');

const CONFIG = require('./config.json');

const api = new TuyaCloud({
	key: CONFIG.appKey,
	secret: CONFIG.appSecret,
	region: CONFIG.countryCode,
});

let DATA_OK = false;

class TuyaDevice {
	constructor(api, name, gid, devId) {
		this.api = api;
		this.name = name;
		this.gid = gid;
		this.devId = devId;
	}

	async request(action, data = {}) {
		data.devId = this.devId;
		return await api.request({ action, data, gid: this.gid });
	}

	getType() {
		return 'generic';
	}
}

class MappableTuyaDevice extends TuyaDevice {
	_getDPSMap() {
		throw new Error('Implement _getDPSMap');
	}

	_mapDPS(rawData, addUnknown) {
		if (!this._dpMap) {
			this._dpMap = this._getDPSMap();
		}

		const res = {};
		for(const key of Object.keys(rawData)) {
			const m = this._dpMap[key] || {};
			if (!m.name && !addUnknown) {
				continue;
			}
			const s = m.name || `unknown_${key}`;
			let v = rawData[key];
			if (m.map) {
				v = m.map(v);
			}
			res[s] = v;
		}

		if (this._addVirtualData) {
			this._addVirtualData(res);
		}

		return res;
	}

	_unmapDPS(mappedData) {
		if (!this._reverseDpMap) {
			const _map = this._getDPSMap();
			const map = {};
			Object.keys(_map).forEach(key => {
				const m = _map[key];
				m.id = key;
				map[m.name] = m;
			});
			this._reverseDpMap = map;
		}


		const res = {};
		for(const key of Object.keys(mappedData)) {
			const m = this._reverseDpMap[key];
			if (!m || !m.settable) {
				continue;
			}

			let v = mappedData[key];
			if (m.unmap) {
				v = m.unmap(v);
			}
			res[m.id] = v;
		}
		return res;
	}

	async get(addUnknown = false) {
		const data = await this.request('tuya.m.device.dp.get');
		return this._mapDPS(data, addUnknown);
	}

	async set(data) {
		const dps = this._unmapDPS(data);
		await this.request('tuya.m.device.dp.publish', { dps })
	}

	makePrometheusGauges() {
		let gauges = MappableTuyaDevice.gauges;
		if (!gauges) {
			gauges = {};
			MappableTuyaDevice.gauges = gauges;
		}

		const map = this._getDPSMap();
		for(const key of Object.keys(map)) {
			const value = map[key];
			if (gauges[value.name] || value.type === 'string') {
				continue;
			}

			const gauge = new prom.Gauge({
				name: value.name,
				help: value.help,
				labelNames: ['name'],
			});

			gauges[value.name] = gauge;
		}
	}

	async writePrometheusGauges() {
		const gauges = MappableTuyaDevice.gauges;

		const data = await this.get();
		for(const key of Object.keys(data)) {
			let value = data[key];
			switch (typeof value) {
				case 'number':
					// No need to process
					break;
				case 'boolean':
					value = value ? 1 : 0;
			}
			gauges[key].set({ name: this.name }, value);
		}
	}
}
MappableTuyaDevice.gauges = {};

class StitchTuyaSocket extends MappableTuyaDevice {
	_getDPSMap() {
		return {
			'1': { name: 'on', help: 'On', type: 'boolean', settable: true, unmap(on) { return !!on; } },
			'4': { name: 'current', help: 'Current (A)', type: 'number', map(a) { return a / 1000.0; } },
			'5': { name: 'power', help: 'Power (W)', type: 'number', map(w) { return w / 10.0; } },
			'6': { name: 'voltage', help: 'Voltage (V)', type: 'number', map(v) { return v / 10.0; } },
			'v1': { name: 'pf', help: 'Power factor', type: 'number' },
			'v2': { name: 'va', help: 'Apparent Power (VA)', type: 'number' },
		};
	}

	_addVirtualData(res) {
		res.va = res.current * res.voltage;
		if (res.va <= 0) {
			res.pf = 1.0;
		} else {
			res.pf = res.power / res.va;
		}
	}

	getType() {
		return 'socket';
	}

	async turnOn() {
		await this.set({ on: true });
	}

	async turnOff() {
		await this.set({ on: false });
	}

	async setPower(on) {
		await this.set({ on });
	}
}

const devices = [];

async function outerPoll() {
	console.log('Poll start');
	const timeout = setTimeout(() => yprocess.exit(2), 30000);
	try {
		await poll();
		DATA_OK = true;
	} catch(e) {
		DATA_OK = false;
		console.error(e.stack || e);
		process.exit(1);
	}
	console.log('Poll end');
	clearTimeout(timeout);
	setTimeout(outerPoll, 2000);
}

async function poll() {
	for(const device of devices) {
		const safeDeviceName = device.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
		await device.writePrometheusGauges();
	}
}

async function main() {
	console.log('Main start');
	const timeout = setTimeout(() => process.exit(3), 30000);

	const loginResult = await api.loginEx({
		email: CONFIG.email,
		password: CONFIG.password,
	});

	console.log('Login done');

	const locations = await api.request({ action: 'tuya.m.location.list' });
	console.log('Got locations done');

	for (const location of locations) {
		const rawDevices = await api.request({ action: 'tuya.m.my.group.device.list', gid: location.groupId });
		console.log('Got product');
		for (const device of rawDevices) {
			let tuyaDev = undefined;
			switch (device.productId) {
				case 'pLrthS5AKLKbAQ77':
					tuyaDev = new StitchTuyaSocket(api, device.name, location.groupId, device.devId);
					break;
			}

			if (tuyaDev) {
				tuyaDev.makePrometheusGauges();
				devices.push(tuyaDev);
			}
		}
	}

	console.log('Main end');
	clearTimeout(timeout);

	outerPoll();
}

async function outerMain() {
	try {
		await main();
	} catch(e) {
		console.error(e.stack || e);
	}
}
outerMain();

const server = http.createServer((req, res) => {
	if (!DATA_OK) {
		res.writeHead(500);
		res.end();
		return;
	}

	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end(prom.register.metrics());
});
server.listen(8001);
