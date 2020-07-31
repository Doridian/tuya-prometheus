import TuyaCloud, { TuyaAction } from '@tuyapi/cloud';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { Gauge, register } from 'prom-client';

interface Config {
	appKey: string;
	appSecret: string;
	countryCode: string;
	email: string;
	password: string;
}
const CONFIG = <Config>JSON.parse(readFileSync('./config/config.json').toString('utf8'));

const globalApi = new TuyaCloud({
	key: CONFIG.appKey,
	secret: CONFIG.appSecret,
	region: CONFIG.countryCode,
});

const DEVICE_REFRESH_INTERVAL = 60 * 60 * 1000;
const DEVICE_INACTIVE_TIMEOUT = 30 * 60 * 1000;

let DATA_OK = false;

let devices: { [key: string]: TuyaDevice } = {};

abstract class TuyaDevice {
	constructor(
		protected readonly api: TuyaCloud,
		protected readonly name: string,
		protected readonly gid: string,
		protected readonly devId: string) {
	}

	public getType() {
		return 'generic';
	}

	public abstract writePrometheusGauges(): Promise<void>;
	public abstract get(addUnknown: boolean): Promise<ValMap>;
	public abstract set(data: ValMap): Promise<void>;

	protected async request(action: TuyaAction, data: { [key: string]: unknown } = {}) {
		data.devId = this.devId;
		return this.api.request({ action, data, gid: this.gid });
	}
}

export interface DPS {
	name: string;
	id?: string;
	help: string;
	type: string;
	settable?: boolean;
	unmap?: (val: number) => unknown;
	map?: (rawVal: unknown) => number;
}

export interface DPSMap { [key: string]: DPS; }

export interface RawValMap { [key: string]: unknown; }
export interface ValMap { [key: string]: number; }

abstract class MappableTuyaDevice extends TuyaDevice {
	public static resetGauges() {
		MappableTuyaDevice.gauges = {};
	}

	protected static gauges?: { [key: string]: Gauge };
	protected dpsMap?: DPSMap;
	protected reversveDpsMap?: DPSMap;

	public abstract getDPSMap(): DPSMap;

	public async get(addUnknown = false) {
		const data = <RawValMap>(await this.request('tuya.m.device.dp.get'));
		return this.mapDPS(data, addUnknown);
	}

	public async set(data: ValMap) {
		const dps = this.unmapDPS(data);
		await this.request('tuya.m.device.dp.publish', { dps });
	}

	public makePrometheusGauges() {
		let gauges = MappableTuyaDevice.gauges;
		if (!gauges) {
			gauges = {};
			MappableTuyaDevice.gauges = gauges;
		}

		const map = this.getDPSMap();
		for (const key of Object.keys(map)) {
			const value = map[key];
			if (gauges[value.name] || value.type === 'string') {
				continue;
			}

			const gauge = new Gauge({
				name: value.name,
				help: value.help,
				labelNames: ['name'],
			});

			gauges[value.name] = gauge;
		}
	}

	public async writePrometheusGauges() {
		let gauges = MappableTuyaDevice.gauges;
		if (!gauges) {
			gauges = {};
			MappableTuyaDevice.gauges = gauges;
		}

		const data = await this.get();
		for (const key of Object.keys(data)) {
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

	protected addVirtualData(_: ValMap): void {
		// Empty on purpose
	}

	protected mapDPS(rawData: RawValMap, addUnknown: boolean): ValMap {
		if (!this.dpsMap) {
			this.dpsMap = this.getDPSMap();
		}

		const res: ValMap = {};
		for (const key of Object.keys(rawData)) {
			const m = this.dpsMap[key] || {};
			if (!m.name && !addUnknown) {
				continue;
			}
			const s = m.name || `unknown_${key}`;
			let v = rawData[key];
			if (m.map) {
				v = m.map(v);
			}
			res[s] = <number>v;
		}

		this.addVirtualData(res);

		return res;
	}

	protected unmapDPS(mappedData: ValMap): RawValMap {
		if (!this.reversveDpsMap) {
			const _map = this.getDPSMap();
			const map: DPSMap = {};
			Object.keys(_map).forEach(key => {
				const m = _map[key];
				m.id = key;
				map[m.name] = m;
			});
			this.reversveDpsMap = map;
		}

		const res: RawValMap = {};
		for (const key of Object.keys(mappedData)) {
			const m = this.reversveDpsMap[key];
			if (!m || !m.settable) {
				continue;
			}

			let v: unknown = mappedData[key];
			if (m.unmap) {
				v = m.unmap(<number>v);
			}
			res[m.id!] = v;
		}
		return res;
	}
}

class StitchTuyaSocket extends MappableTuyaDevice {
	public getDPSMap() {
		return {
			1: { name: 'power_on', help: 'On', type: 'boolean', settable: true, unmap(on: unknown) { return !!on; } },
			4: { name: 'current', help: 'Current (A)', type: 'number', map(a: unknown) { return <number>a / 1000.0; } },
			5: { name: 'power', help: 'Power (W)', type: 'number', map(w: unknown) { return <number>w / 10.0; } },
			6: { name: 'voltage', help: 'Voltage (V)', type: 'number', map(v: unknown) { return <number>v / 10.0; } },
			v1: { name: 'pf', help: 'Power factor', type: 'number' },
			v2: { name: 'va', help: 'Apparent Power (VA)', type: 'number' },
		};
	}

	public addVirtualData(res: ValMap) {
		res.va = res.current * res.voltage;
		res.pf = (res.va <= 0) ? 1.0 : (res.power / res.va);
	}

	public getType() {
		return 'socket';
	}

	public async turnOn() {
		await this.setPower(true);
	}

	public async turnOff() {
		await this.setPower(false);
	}

	public async setPower(on: boolean) {
		await this.set({ on: on ? 1 : 0 });
	}
}

let lastDeviceRefresh = 0;
async function outerPoll() {
	console.log('Poll start');

	const timeout = setTimeout(() => process.exit(2), 30000);

	if (Date.now() - lastDeviceRefresh > DEVICE_REFRESH_INTERVAL) {
		await refreshDevices();
	}

	try {
		await poll();
		DATA_OK = true;
	} catch (e) {
		DATA_OK = false;
		console.error((<Error>e).stack || e);
		process.exit(1);
	}

	console.log('Poll end');

	clearTimeout(timeout);

	setTimeout(outerPoll, 2000);
}

function processDeviceName(name: string) {
	return name.toLowerCase().trim().replace(/[ \t\r\n_]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

async function poll() {
	for (const device of Object.values(devices)) {
		await device.writePrometheusGauges();
	}
}

async function main() {
	console.log('Main start');
	const timeout = setTimeout(() => process.exit(3), 30000);

	await globalApi.loginEx({
		email: CONFIG.email,
		password: CONFIG.password,
	});

	console.log('Login done');

	await refreshDevices();

	console.log('Main end');
	clearTimeout(timeout);

	// tslint:disable-next-line:no-floating-promises
	outerPoll();
}

async function refreshDevices() {
	lastDeviceRefresh = Date.now();
	devices = {};
	MappableTuyaDevice.resetGauges();

	const minDpMaxTime = Date.now() - DEVICE_INACTIVE_TIMEOUT;

	const locations = await globalApi.request({ action: 'tuya.m.location.list' });
	console.log('Got locations done');

	for (const location of locations) {
		const rawDevices = await globalApi.request({ action: 'tuya.m.my.group.device.list', gid: location.groupId });
		console.log('Got products');
		for (const device of rawDevices) {
			console.log('Device: ', device.name, device.dpMaxTime, minDpMaxTime);

			if (device.dpMaxTime && device.dpMaxTime < minDpMaxTime) {
				continue;
			}

			let tuyaDev;
			switch (device.productId) {
				case 'pLrthS5AKLKbAQ77':
					tuyaDev = new StitchTuyaSocket(globalApi, device.name, location.groupId, device.devId);
					break;
			}

			if (tuyaDev) {
				tuyaDev.makePrometheusGauges();
				devices[processDeviceName(device.name)] = tuyaDev;
			}
		}
	}
}

async function outerMain() {
	try {
		await main();
	} catch (e) {
		console.error((<Error>e).stack || e);
	}
}
// tslint:disable-next-line:no-floating-promises
outerMain();

const server = createServer((req, res) => {
	if (!DATA_OK) {
		res.writeHead(500);
		res.end();
		return;
	}

	if (req.method === 'PUT') {
		const dev = devices[processDeviceName(req.url!.substr(1))];
		if (!dev) {
			res.writeHead(404);
			res.end();
			return;
		}

		let body = '';
		req.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on('end', () => {
			res.writeHead(204);
			res.end();

			const data = <ValMap>JSON.parse(body);
			dev.set(data)
			.catch(e => {
				console.error((<Error>e).stack || e);
			});
		});
		return;
	}

	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end(register.metrics());
});
server.listen(8001);
