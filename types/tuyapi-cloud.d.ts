declare module '@tuyapi/cloud' {
    export interface TuyaConfig {
        key: string;
        secret: string;
        region: string;
    }

    export type TuyaAction = 'tuya.m.my.group.device.list' | 'tuya.m.location.list' | 'tuya.m.device.dp.get' | 'tuya.m.device.dp.publish';

    export interface TuyaRequest {
        action: TuyaAction;
        data?: unknown;
        gid?: string;
    }


    export interface TuyaDeviceListRequest extends TuyaRequest {
        action: 'tuya.m.my.group.device.list';
    }

    export interface TuyaLocationListRequest extends TuyaRequest {
        action: 'tuya.m.location.list';
    }

    export interface TuyaDeviceDPGetRequest extends TuyaRequest {
        action: 'tuya.m.device.dp.get';
    }

    export interface TuyaDeviceDPPublishRequest extends TuyaRequest {
        action: 'tuya.m.device.dp.publish';
    }

    export interface TuyaLoginRequest {
        email: string;
        password: string;
    }

    export interface LocationResponse {
        groupId: string;
        name: string;
    }

    export interface DeviceResponse {
        productId: string;
        dpMaxTime?: number;
        name: string;
        devId: string;
    }

    export default class TuyaCloud {
        constructor(config: TuyaConfig);
        request(req: TuyaDeviceListRequest): Promise<DeviceResponse[]>;
        request(req: TuyaLocationListRequest): Promise<LocationResponse[]>;
        request(req: TuyaDeviceDPGetRequest): Promise<{ [key: string]: unknown }>;
        request(req: TuyaDeviceDPPublishRequest): Promise<void>;
        request(req: TuyaRequest): Promise<unknown>;
        loginEx(req: TuyaLoginRequest): Promise<void>;
    }
}