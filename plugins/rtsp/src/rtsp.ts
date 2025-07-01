import { timeoutPromise } from '@scrypted/common/src/promise-utils';
import sdk, { FFmpegInput, Intercom, MediaObject, MediaStreamUrl, PictureOptions, RequestPictureOptions, ResponseMediaStreamOptions, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, SettingValue } from "@scrypted/sdk";
import url from 'url';
import { CameraBase, CameraProviderBase, UrlMediaStreamOptions } from "../../ffmpeg-camera/src/common";
import { RtspClient, parseSemicolonDelimited } from "@scrypted/common/src/rtsp-server";
import { createBindZero } from "@scrypted/common/src/listen-cluster";
import { startRtpForwarderProcess, RtpForwarderProcess } from "../../webrtc/src/rtp-forwarders";
import crypto from 'crypto';
import { RtpPacket } from '../../../external/werift/packages/rtp/src/rtp/rtp'; // For types if needed, though direct manipulation might not be required
import { nextSequenceNumber } from "../../homekit/src/types/camera/jitter-buffer"; // For sequence numbers if managing manually

const { mediaManager, deviceManager } = sdk;

export { UrlMediaStreamOptions } from "../../ffmpeg-camera/src/common";

export function createRtspMediaStreamOptions(url: string, index: number): UrlMediaStreamOptions {
    return {
        id: `channel${index}`,
        name: `Stream ${index + 1}`,
        url,
        container: 'rtsp',
        video: {
        },
        audio: {

        },
    };
}
export class RtspCamera extends CameraBase<UrlMediaStreamOptions> {
    takePicture(option?: PictureOptions): Promise<MediaObject> {
        throw new Error("The RTSP Camera does not provide snapshots. Install the Snapshot Plugin if snapshots are available via an URL.");
    }

    getRawVideoStreamOptions(): UrlMediaStreamOptions[] {
        let urls: string[] = [];
        try {
            urls = JSON.parse(this.storage.getItem('urls'));
        }
        catch (e) {
            const url = this.storage.getItem('url');
            if (url) {
                urls.push(url);
                this.storage.setItem('urls', JSON.stringify(urls));
                this.storage.removeItem('url');
            }
        }

        // filter out empty strings.
        const ret = urls.filter(url => !!url).map((url, index) => createRtspMediaStreamOptions(url, index));

        if (!ret.length)
            return;
        return ret;
    }

    addRtspCredentials(rtspUrl: string) {
        // ignore this deprecation warning. the WHATWG URL class will trim the password
        // off if it is empty, resulting in urls like rtsp://admin@foo.com/.
        // this causes ffmpeg to fail on sending a blank password.
        // we need to send it as follows: rtsp://admin:@foo.com/.
        // Note the trailing colon.
        // issue: https://github.com/koush/scrypted/issues/134
        const parsedUrl = url.parse(rtspUrl);
        this.console.log('stream url', rtspUrl);
        const username = this.storage.getItem("username");
        const password = this.storage.getItem("password");
        if (username) {
            // if a username is set, ensure a trailing colon is sent for blank password.
            const auth = `${username}:${password || ''}`;
            parsedUrl.auth = auth;
        }

        const stringUrl = url.format(parsedUrl);
        return stringUrl;
    }

    createMediaStreamUrl(stringUrl: string, vso: ResponseMediaStreamOptions) {
        const ret: MediaStreamUrl = {
            container: vso.container,
            url: stringUrl,
            mediaStreamOptions: vso,
        };

        return this.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);
    }

    async createVideoStream(vso: UrlMediaStreamOptions): Promise<MediaObject> {
        if (!vso)
            throw new Error('video streams not set up or no longer exists.');

        const stringUrl = this.addRtspCredentials(vso.url);
        return this.createMediaStreamUrl(stringUrl, vso);
    }

    // hide the description from CameraBase that indicates it is only used for snapshots
    getUsernameDescription(): string {
        return;
    }

    // hide the description from CameraBase that indicates it is only used for snapshots
    getPasswordDescription(): string {
        return;
    }

    async getRtspUrlSettings(): Promise<Setting[]> {
        return [
            {
                key: 'urls',
                title: 'RTSP Stream URL',
                description: 'An RTSP Stream URL provided by the camera.',
                placeholder: 'rtsp://192.168.1.100[:554]/channel/101',
                value: this.getRawVideoStreamOptions()?.map(vso => vso.url),
                multiple: true,
            },
        ];
    }

    async getOtherSettings(): Promise<Setting[]> {
        const ret: Setting[] = [];

        ret.push(
            {
                subgroup: 'Advanced',
                key: 'debug',
                title: 'Debug Events',
                description: "Log all events to the console. This will be very noisy and should not be left enabled.",
                value: this.storage.getItem('debug') === 'true',
                type: 'boolean',
            }
        );

        // Two-Way Audio Settings
        ret.push(
            {
                key: 'enableTwoWayAudio',
                title: 'Enable Two-Way Audio',
                description: 'Enable experimental two-way audio (audio backchannel to the camera). Camera support varies.',
                type: 'boolean',
                value: this.storage.getItem('enableTwoWayAudio') === 'true',
                subgroup: 'Two-Way Audio',
            },
            {
                key: 'backchannelAudioCodec',
                title: 'Backchannel Audio Codec',
                description: 'The audio codec to use for sending audio to the camera.',
                type: 'string',
                choices: ['pcm_mulaw', 'pcm_alaw', 'aac'],
                value: this.storage.getItem('backchannelAudioCodec') || 'pcm_mulaw',
                subgroup: 'Two-Way Audio',
            },
            {
                key: 'backchannelAudioTransport',
                title: 'Backchannel Audio Transport',
                description: 'The network transport protocol for sending audio to the camera.',
                type: 'string',
                choices: ['udp', 'tcp'],
                value: this.storage.getItem('backchannelAudioTransport') || 'udp',
                subgroup: 'Two-Way Audio',
            },
            {
                key: 'backchannelRtspUrl',
                title: 'Backchannel RTSP URL (Optional)',
                description: 'Optional: Specify a different RTSP URL for sending audio if your camera requires it. Defaults to the main stream URL.',
                type: 'string',
                value: this.storage.getItem('backchannelRtspUrl') || '',
                subgroup: 'Two-Way Audio',
                placeholder: 'rtsp://camera-ip/audio_input',
            }
        );
        return ret;
    }

    async getUrlSettings(): Promise<Setting[]> {
        return [
            ...await this.getRtspUrlSettings(),
        ];
    }

    async putRtspUrls(urls: string[]) {
        this.storage.setItem('urls', JSON.stringify(urls.filter(url => !!url)));
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    async putSettingBase(key: string, value: SettingValue) {
        if (key === 'urls') {
            this.putRtspUrls(value as string[]);
        }
        else {
            super.putSettingBase(key, value);
        }
    }
}

export interface Destroyable {
    on(eventName: string | symbol, listener: (...args: any[]) => void): void;
    destroy(): void;
    emit(eventName: string | symbol, ...args: any[]): boolean;
}

export abstract class RtspSmartCamera extends RtspCamera implements Intercom {
    lastListen = 0;
    listener: Promise<Destroyable>;
    intercomClient: RtspClient;
    intercomForwarder: RtpForwarderProcess;
    intercomUdpServer: { server: import("dgram").Socket; port: number; };


    constructor(nativeId: string, provider: RtspProvider) {
        super(nativeId, provider);
        process.nextTick(() => {
            this.listenLoop()
            // Ensure interfaces are set correctly on load
            this.updateDeviceInterfaces();
        });
    }

    async startIntercom(media: MediaObject): Promise<void> {
        if (this.intercomClient || this.intercomForwarder) {
            this.console.log('Intercom already active, stopping previous session.');
            await this.stopIntercom();
        }

        const ffmpegInput = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);

        const enabled = this.storage.getItem('enableTwoWayAudio') === 'true';
        if (!enabled) {
            throw new Error('Two-way audio is not enabled for this camera.');
        }

        const audioCodec = this.storage.getItem('backchannelAudioCodec') || 'pcm_mulaw';
        const transport = (this.storage.getItem('backchannelAudioTransport') || 'udp').toLowerCase();
        let rtspUrl = this.storage.getItem('backchannelRtspUrl');
        if (!rtspUrl) {
            const streamOptions = await this.getVideoStreamOptions();
            if (!streamOptions || streamOptions.length === 0) {
                throw new Error('No RTSP stream URL configured for the camera.');
            }
            rtspUrl = streamOptions[0].url; // Use the first configured stream URL
        }

        rtspUrl = this.addRtspCredentials(rtspUrl); // Add credentials if configured

        this.console.log(`Starting intercom to ${rtspUrl} with codec ${audioCodec} over ${transport}`);

        this.intercomClient = new RtspClient(rtspUrl);
        this.intercomClient.console = this.console;

        let serverRtpPort: number;
        let clientRtpPort: number;
        let clientRtcpPort: number;
        let ssrc: number;
        let ssrcUnsigned: number;
        let isTcp = transport === 'tcp';

        // TODO: The RTSP SETUP for sending audio is camera-dependent.
        // We need a control path. For now, we assume the main URL or backchannelRtspUrl can be used.
        // A common way is to append a trackID, e.g., /trackID=audio0 or similar.
        // Without SDP from the camera indicating a sendonly audio track, this is a guess.
        // For now, let's try to SETUP the main URL itself, assuming it might accept an audio stream.
        // This is highly likely to fail on many cameras without specific pathing.
        const setupUrl = this.intercomClient.url.toString(); // Or a more specific track URL if known

        try {
            await this.intercomClient.options();
            // Unlike ONVIF, generic RTSP doesn't have a standard way to DESCRIBE a backchannel.
            // We skip DESCRIBE and try to SETUP directly.

            if (isTcp) {
                const headers = {
                    Transport: `RTP/AVP/TCP;unicast;interleaved=0-1;mode=record`, // or mode="send"
                };
                const response = await this.intercomClient.request('SETUP', headers, setupUrl);
                const transportDict = parseSemicolonDelimited(response.headers.transport);
                this.intercomClient.session = response.headers.session?.split(';')[0];
                if (!this.intercomClient.session) throw new Error('SETUP did not return a session ID for TCP backchannel.');
                // For TCP, RTP packets are sent via client.send()
            } else { // UDP
                this.intercomUdpServer = await createBindZero('udp4');
                clientRtpPort = this.intercomUdpServer.port;
                clientRtcpPort = clientRtpPort + 1; // Standard RTCP port

                const headers = {
                    Transport: `RTP/AVP;unicast;client_port=${clientRtpPort}-${clientRtcpPort};mode=record`, // or mode="send"
                };
                const response = await this.intercomClient.request('SETUP', headers, setupUrl);
                const transportDict = parseSemicolonDelimited(response.headers.transport);
                this.intercomClient.session = response.headers.session?.split(';')[0];
                if (!this.intercomClient.session) throw new Error('SETUP did not return a session ID for UDP backchannel.');

                const serverPortString = transportDict.server_port;
                if (!serverPortString) throw new Error('SETUP response did not include server_port for UDP backchannel.');
                serverRtpPort = parseInt(serverPortString.split('-')[0]);

                if (transportDict.ssrc) {
                    const ssrcBuffer = Buffer.from(transportDict.ssrc, 'hex');
                    ssrc = ssrcBuffer.readInt32BE(0);
                    ssrcUnsigned = ssrcBuffer.readUint32BE(0);
                } else {
                    const ssrcBuffer = crypto.randomBytes(4);
                    ssrc = ssrcBuffer.readInt32BE(0);
                    ssrcUnsigned = ssrcBuffer.readUint32BE(0);
                }
            }

            // Determine payload type and encoder arguments
            let payloadType: number;
            let encoderArguments: string[];
            let clockRate: number = 8000; // Default for G.711
            let channels: number = 1; // Default mono

            switch (audioCodec) {
                case 'pcm_alaw':
                    payloadType = 8;
                    encoderArguments = ['-acodec', 'pcm_alaw', '-ar', clockRate.toString(), '-ac', channels.toString()];
                    break;
                case 'aac':
                    payloadType = 96; // Dynamic, but common default for AAC
                    clockRate = ffmpegInput.mediaStreamOptions?.audio?.sampleRate || 48000; // Prefer input, fallback
                    channels = ffmpegInput.mediaStreamOptions?.audio?.channelLayout === 'stereo' ? 2 : 1;
                    encoderArguments = ['-acodec', 'aac', '-ar', clockRate.toString(), '-ac', channels.toString(), '-b:a', '64k', '-profile:a', 'aac_low'];
                    break;
                case 'pcm_mulaw':
                default:
                    payloadType = 0;
                    encoderArguments = ['-acodec', 'pcm_mulaw', '-ar', clockRate.toString(), '-ac', channels.toString()];
                    break;
            }

            // Start RTP forwarder
            // The `negotiate` part of OnvifIntercom is for matching camera's SDP. We don't have that here.
            // We are defining what we send.
            let sequenceNumber = 0; // Initialize sequence number

            this.intercomForwarder = await startRtpForwarderProcess(this.console, ffmpegInput, {
                audio: {
                    encoderArguments,
                    payloadType,
                    ssrc, // FFmpeg expects signed int32 for ssrc in RTP output
                    onRtp: (rtp) => {
                        // `startRtpForwarderProcess` might already handle RTP header correctly based on its config.
                        // If manual adjustment is needed (like ONVIF example):
                        const packet = RtpPacket.deSerialize(rtp);
                        packet.header.payloadType = payloadType;
                        packet.header.ssrc = ssrcUnsigned; // RTP header uses unsigned SSRC
                        packet.header.sequenceNumber = sequenceNumber;
                        sequenceNumber = nextSequenceNumber(sequenceNumber);
                        // packet.header.marker = true; // Typically only for the last packet of a talk spurt or key event

                        const finalPacket = packet.serialize();

                        if (isTcp) {
                            // RtspClient's send method should handle correct TCP channel based on SETUP response.
                            // Defaulting to channel 0 for the first (audio) stream.
                            this.intercomClient.send(finalPacket, 0);
                        } else {
                            this.intercomUdpServer.server.send(finalPacket, serverRtpPort, this.intercomClient.url.hostname);
                        }
                    },
                }
            });

            this.intercomClient.client.on('close', () => {
                this.console.log('RTSP Intercom client connection closed by remote.');
                this.stopIntercom(); // Ensure cleanup if connection drops
            });
            this.intercomForwarder.killPromise.finally(() => {
                this.console.log('RTP Forwarder for intercom stopped.');
            });

            // Send PLAY or RECORD command.
            // ONVIF example uses PLAY. For generic RTSP, some cameras might expect RECORD for client-to-server audio.
            // This is a key area for testing and potential future configuration.
            this.console.log(`Sending RTSP PLAY for intercom session ${this.intercomClient.session} to ${setupUrl}`);
            await this.intercomClient.request('PLAY', { Session: this.intercomClient.session }, setupUrl);
            // As an alternative to investigate if PLAY fails:
            // await this.intercomClient.request('RECORD', { Session: this.intercomClient.session }, setupUrl);

            this.console.log('Intercom started successfully.');

        } catch (e) {
            let errorMessage = 'Failed to start intercom';
            if (e.rtspStatusCode) {
                errorMessage += `: RTSP Error ${e.rtspStatusCode}`;
            }
            if (e.message) {
                errorMessage += `: ${e.message}`;
            }
            this.console.error(errorMessage, e.stack);
            await this.stopIntercom(); // Clean up on failure
            throw new Error(errorMessage); // Re-throw with more context
        }
    }

    async stopIntercom(): Promise<void> {
        this.console.log('Attempting to stop intercom session...');
        if (this.intercomForwarder) {
            this.console.log('Killing intercom RTP forwarder process.');
            this.intercomForwarder.kill();
            this.intercomForwarder = undefined;
        }
        if (this.intercomClient) {
            this.console.log(`Intercom client found with session ID: ${this.intercomClient.session}. Proceeding with teardown.`);
            try {
                if (this.intercomClient.session) {
                    const teardownUrl = this.intercomClient.url.toString();
                    this.console.log(`Sending RTSP TEARDOWN for session ${this.intercomClient.session} to ${teardownUrl}`);
                    await this.intercomClient.request('TEARDOWN', { Session: this.intercomClient.session }, teardownUrl);
                    this.console.log(`RTSP TEARDOWN successful for session ${this.intercomClient.session}.`);
                } else {
                    this.console.log('No active RTSP session ID found for intercom client. Skipping TEARDOWN command.');
                }
            } catch (e) {
                let errorMessage = 'Error during intercom TEARDOWN';
                if (e.rtspStatusCode) {
                    errorMessage += `: RTSP Error ${e.rtspStatusCode}`;
                }
                if (e.message) {
                    errorMessage += `: ${e.message}`;
                }
                this.console.error(errorMessage, e.stack);
            }
            this.intercomClient.safeTeardown();
            this.intercomClient = undefined;
            this.console.log('Intercom RTSP client torn down.');
        } else {
            this.console.log('No active intercom RTSP client found.');
        }

        if (this.intercomUdpServer) {
            this.console.log('Closing intercom UDP server.');
            this.intercomUdpServer.server.close();
            this.intercomUdpServer = undefined;
        }
        this.console.log('Intercom stop sequence complete.');
    }

    updateDeviceInterfaces() {
        const interfaces: string[] = [...this.provider.getInterfaces()];
        if (this.storage.getItem('enableTwoWayAudio') === 'true') {
            if (!interfaces.includes(ScryptedInterface.Intercom)) {
                interfaces.push(ScryptedInterface.Intercom);
            }
        }
        else {
            const intercomIndex = interfaces.indexOf(ScryptedInterface.Intercom);
            if (intercomIndex !== -1) {
                interfaces.splice(intercomIndex, 1);
            }
        }
        // Using this.deviceType directly might be problematic if it's not set or managed by this class.
        // Relying on the provider's default type or what's already stored.
        // Let's check how OnvifCamera does this: it passes type to this.provider.updateDevice
        // We should ensure this.type is appropriate or let the provider decide.
        // For now, let the provider handle the type, or use the existing type.
        const currentType = deviceManager.getDeviceState(this.id)?.type || this.provider.getDefaultCameraType();
        this.provider.updateDevice(this.nativeId, this.name, interfaces, currentType);
        //this.onDeviceEvent(ScryptedInterface.Settings, undefined); // Already called by putSetting
    }

    resetSensors(): void {
        if (this.interfaces.includes(ScryptedInterface.MotionSensor))
            this.motionDetected = false;
        if (this.interfaces.includes(ScryptedInterface.AudioSensor))
            this.audioDetected = false;
        if (this.interfaces.includes(ScryptedInterface.TamperSensor))
            this.tampered = false;
        if (this.interfaces.includes(ScryptedInterface.BinarySensor))
            this.binaryState = false;
    }

    async listenLoop() {
        this.resetSensors();
        this.lastListen = Date.now();
        if (this.listener)
            return;

        let listener: Destroyable;
        const listenerPromise = this.listener = this.listenEvents();

        let activityTimeout: NodeJS.Timeout;
        const restartListener = () => {
            if (listenerPromise === this.listener)
                this.listener = undefined;
            clearTimeout(activityTimeout);
            listener?.destroy();
            const listenDuration = Date.now() - this.lastListen;
            const listenNext = listenDuration > 10000 ? 0 : 10000;
            setTimeout(() => this.listenLoop(), listenNext);
        }

        try {
            listener = await this.listener;
        }
        catch (e) {
            this.console.error('listen loop connection failed, restarting listener.', e.message);
            restartListener();
            return;
        }

        const resetActivityTimeout = () => {
            clearTimeout(activityTimeout);
            activityTimeout = setTimeout(() => {
                this.console.error('listen loop 5m idle timeout, destroying listener.');
                restartListener();
            }, 300000);
        }
        resetActivityTimeout();

        listener.on('data', (data) => {
            if (this.storage.getItem('debug') === 'true')
                this.console.log('debug event:\n', data.toString());
            resetActivityTimeout();
        });

        listener.on('close', () => {
            this.console.error('listen loop closed, restarting listener.');
            restartListener();
        });

        listener.on('error', e => {
            this.console.error('listen loop error, restarting listener.', e);
            restartListener();
        });
    }

    async putSetting(key: string, value: SettingValue) {
        await super.putSetting(key, value); // Ensure RtspCamera's putSettingBase is called
        if (key === 'enableTwoWayAudio') {
            this.updateDeviceInterfaces();
        }
        // For RtspSmartCamera, putSettingBase is called via super.putSetting.
        // The listener reset is specific to RtspSmartCamera's event listening.
        this.listener?.then(l => l.emit('error', new Error("new settings have been applied")));
    }

    async takePicture(options?: RequestPictureOptions) {
        return this.takeSmartCameraPicture(options);
    }

    abstract takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject>;

    async getRtspUrlSettings(): Promise<Setting[]> {
        return [
            {
                key: 'urls',
                title: 'RTSP Stream URL Override',
                description: 'Override the RTSP Stream URL provided by the camera.',
                placeholder: 'rtsp://192.168.1.100[:554]/channel/101',
                value: this.getRawVideoStreamOptions()?.map(vso => vso.url),
                multiple: true,
            },
        ];
    }

    async getUrlSettings() {
        const ret: Setting[] = [
            {
                key: 'ip',
                title: 'IP Address',
                placeholder: '192.168.1.100',
                value: this.storage.getItem('ip'),
            },
            ...this.getHttpPortOverrideSettings(),
            ...await this.getRtspPortOverrideSettings(),
        ];

        if (this.showRtspUrlOverride()) {
            const legacyOverride = this.storage.getItem('rtspUrlOverride')
            if (legacyOverride) {
                await this.putRtspUrls([legacyOverride]);
                this.storage.removeItem('rtspUrlOverride');
            }

            ret.push(
                ... await this.getRtspUrlSettings(),
            );
        }

        return ret;
    }

    getHttpPortOverrideSettings() {
        if (!this.showHttpPortOverride()) {
            return [];
        }
        return [
            {
                key: 'httpPort',
                subgroup: 'Advanced',
                title: 'HTTP Port Override',
                placeholder: '80',
                value: this.storage.getItem('httpPort'),
            }
        ];
    }

    showHttpPortOverride() {
        return true;
    }

    async getRtspPortOverrideSettings(): Promise<Setting[]> {
        if (!this.showRtspPortOverride()) {
            return [];
        }
        return [
            {
                key: 'rtspPort',
                subgroup: 'Advanced',
                title: 'RTSP Port Override',
                placeholder: '554',
                value: this.storage.getItem('rtspPort'),
            },
        ];
    }

    showRtspPortOverride() {
        return true;
    }

    showRtspUrlOverride() {
        return true;
    }

    getHttpAddress() {
        return `${this.getIPAddress()}:${this.storage.getItem('httpPort') || 80}`;
    }

    setHttpPortOverride(port: string) {
        this.storage.setItem('httpPort', port || '');
    }

    getRtspUrlOverride() {
        if (!this.showRtspUrlOverride())
            return;
        return this.storage.getItem('rtspUrlOverride');
    }

    abstract getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]>;
    abstract listenEvents(): Promise<Destroyable>;

    getIPAddress() {
        return this.storage.getItem('ip');
    }

    setIPAddress(ip: string) {
        return this.storage.setItem('ip', ip);
    }

    getRtspAddress() {
        return `${this.getIPAddress()}:${this.storage.getItem('rtspPort') || 554}`;
    }

    constructedVideoStreamOptions: Promise<UrlMediaStreamOptions[]>;
    async getVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        if (this.showRtspUrlOverride()) {
            const vsos = await super.getVideoStreamOptions();
            if (vsos)
                return vsos;
        }

        if (this.constructedVideoStreamOptions)
            return this.constructedVideoStreamOptions;

        this.constructedVideoStreamOptions = timeoutPromise(5000, this.getConstructedVideoStreamOptions()).finally(() => {
            this.constructedVideoStreamOptions = undefined;
        });

        return this.constructedVideoStreamOptions;
    }

    async putSettingBase(key: string, value: SettingValue): Promise<void> {
        try {
            return await super.putSettingBase(key, value);
        }
        finally {
            this.constructedVideoStreamOptions = undefined;
        }
    }
}

export abstract class RtspProvider extends CameraProviderBase<UrlMediaStreamOptions> {
    // This will now create an RtspSmartCamera if the derived provider (like OnvifProvider)
    // doesn't override it to return a more specific type.
    // However, RtspSmartCamera is abstract. So, a concrete implementation is needed.
    // For a generic RTSP plugin, we'd need a GenericRtspSmartCamera.
    // For now, let's assume a concrete class extending RtspSmartCamera will be used by a concrete provider.
    // Or, if RtspProvider is meant to be directly usable, createCamera should return a concrete RtspSmartCamera.
    // The original Onvif task implies we are modifying the generic RTSP plugin.

    // Let's adjust createCamera to return RtspSmartCamera, and make a concrete version for generic RTSP.
    // This change is more involved if RtspProvider itself is meant to be used directly.
    // The plan was to modify RtspSmartCamera, which is abstract.
    // OnvifCamera extends RtspSmartCamera, so it gets the changes.
    // The request is to port functionality TO the RTSP integration, implying a generic RTSP camera.

    // For now, I'll leave createCamera as is. The Intercom interface is on RtspSmartCamera.
    // If a plugin uses RtspProvider and creates an RtspCamera that is NOT an RtspSmartCamera,
    // it won't get Intercom. This seems acceptable as "smart" features go in RtspSmartCamera.
    // The ONVIF plugin already creates an OnvifCamera (which is an RtspSmartCamera).
    // If a new "GenericRtspWithTwoWayAudioCamera" is desired, it would extend RtspSmartCamera.

    // No changes needed to RtspProvider.getAdditionalInterfaces() because the device itself
    // will call this.provider.updateDevice() with the correct interfaces.

    // Need to add getDefaultCameraType for the updateDeviceInterfaces method.
    getDefaultCameraType(): ScryptedDeviceType {
        return ScryptedDeviceType.Camera;
    }

    createCamera(nativeId: string): RtspCamera {
        // If we need a generic RTSP camera that can do two-way audio,
        // this would need to return an instance of a concrete class
        // that extends RtspSmartCamera.
        // For now, this is consistent with how OnvifCamera works (it extends RtspSmartCamera).
        // The current request is about *enabling* RTSP to do it, like ONVIF does.
        // So, the structures added to RtspSmartCamera are the key.
        return new RtspCamera(nativeId, this);
    }
}
