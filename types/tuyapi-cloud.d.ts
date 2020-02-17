declare module '@tuyapi/cloud' {
    export interface TuyaConfig {
        key: string;
        secret: string;
        region: string;
    }

    export interface TuyaRequest {
        action: string;
        data?: unknown;
        gid?: string;
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
        name: string;
        devId: string;
    }

    export default class TuyaCloud {
        constructor(config: TuyaConfig);
        request<T>(req: TuyaRequest): Promise<T>;
        loginEx(req: TuyaLoginRequest): Promise<void>;
    }
}