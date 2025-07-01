import { timeoutPromise } from '@scrypted/common/src/promise-utils';
import sdk, { Intercom, MediaObject, MediaStreamUrl, PictureOptions, RequestPictureOptions, ResponseMediaStreamOptions, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, SettingValue } from "@scrypted/sdk";
import url from 'url';
import { CameraBase, CameraProviderBase, UrlMediaStreamOptions } from "../../ffmpeg-camera/src/common";

const { deviceManager } = sdk;

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

        // Two-Way Audio Settings - MINIMAL
        ret.push(
            {
                key: 'enableTwoWayAudio',
                title: 'Enable Two-Way Audio (Experimental)',
                description: 'Enable experimental two-way audio. The plugin will attempt to auto-negotiate transport (UDP then TCP) and codec (AAC > PCMU > PCMA) based on camera capabilities advertised via SDP.',
                type: 'boolean',
                value: this.storage.getItem('enableTwoWayAudio') === 'true',
                subgroup: 'Two-Way Audio',
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

export abstract class RtspSmartCamera extends RtspCamera implements Intercom { // Ensure Intercom is implemented
    lastListen = 0;
    listener: Promise<Destroyable>;
    // Placeholders for intercom state
    intercomClient: any;
    intercomForwarder: any;
    intercomClient: RtspClient;
    intercomForwarder: RtpForwarderProcess;
    intercomUdpServer: { server: import("dgram").Socket; port: number; };

    constructor(nativeId: string, provider: RtspProvider) {
        super(nativeId, provider);
        process.nextTick(() => {
            this.listenLoop();
            this.updateDeviceInterfaces(); // Call on init
        });
    }

    async startIntercom(media: MediaObject): Promise<void> {
        this.console.log('Attempting to start intercom (minimal config)...');
        if (this.intercomClient || this.intercomForwarder) {
            this.console.log('Intercom session already active. Stopping previous session.');
            await this.stopIntercom();
        }

        const enabled = this.storage.getItem('enableTwoWayAudio') === 'true';
        if (!enabled) {
            this.console.error('Two-way audio is not enabled for this camera in settings.');
            throw new Error('Two-way audio is not enabled for this camera.');
        }

        const ffmpegInput = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
        if (!ffmpegInput) {
            this.console.error('Failed to convert MediaObject to FFmpegInput.');
            throw new Error('Could not process microphone input.');
        }

        const streamOptions = await this.getVideoStreamOptions();
        if (!streamOptions || streamOptions.length === 0 || !streamOptions[0].url) {
            this.console.error('No primary RTSP stream URL configured for the camera to use for DESCRIBE.');
            throw new Error('No primary RTSP stream URL configured for the camera.');
        }
        const describeUrl = this.addRtspCredentials(streamOptions[0].url);
        this.console.log(`Using primary stream URL for DESCRIBE: ${describeUrl}`);

        this.intercomClient = new RtspClient(describeUrl);
        this.intercomClient.console = this.console;

        let sdp: string;
        let selectedTrack: MSection = null;
        let selectedCodecInfo: { name: string, payloadType: number, clockRate: number, ffmpegEncodingName: string, channels: number } = null;
        let setupUrl: string;
        // For storing results from successful SETUP
        let currentSessionId: string;
        let serverRtpPortUdp: number; // Only for UDP
        let ssrcUnsigned: number;
        let chosenTransport: 'udp' | 'tcp';
        let confirmedTransportDict: ReturnType<typeof parseSemicolonDelimited>;


        try {
            this.console.log(`Sending DESCRIBE request to ${describeUrl}`);
            const describeResponse = await this.intercomClient.describe();
            if (!describeResponse.body) throw new Error('DESCRIBE response contained no SDP body.');
            sdp = describeResponse.body.toString();
            this.console.debug("Received SDP for intercom negotiation:\n", sdp);

            const parsedSdp = parseSdp(sdp);
            const codecPreferences = [
                { sdpName: 'MPEG4-GENERIC', ffmpegName: 'aac', preferredChannels: 2 },
                { sdpName: 'PCMU', ffmpegName: 'pcm_mulaw', preferredChannels: 1 },
                { sdpName: 'PCMA', ffmpegName: 'pcm_alaw', preferredChannels: 1 },
            ];

            for (const mSection of parsedSdp.msections) {
                if (mSection.type === 'audio' && (mSection.attributes?.includes('sendonly') || mSection.attributes?.includes('sendrecv'))) {
                    for (const pref of codecPreferences) {
                        const rtpmap = mSection.rtpmaps?.find(r => r.codec.toUpperCase() === pref.sdpName);
                        if (rtpmap) {
                            selectedTrack = mSection;
                            selectedCodecInfo = {
                                name: pref.sdpName, payloadType: rtpmap.payloadType, clockRate: rtpmap.clock,
                                ffmpegEncodingName: pref.ffmpegName,
                                channels: (pref.ffmpegName === 'aac' && (rtpmap.channels || 1) >= pref.preferredChannels) ? pref.preferredChannels : (rtpmap.channels || 1),
                            };
                            break;
                        }
                    }
                }
                if (selectedTrack) break;
            }

            if (!selectedTrack || !selectedCodecInfo) {
                throw new Error("Camera does not advertise a supported audio input stream (AAC, PCMU, PCMA with a=sendonly/a=sendrecv) via SDP.");
            }
            this.console.log(`Selected audio input track: ${selectedTrack.control}, Codec: ${selectedCodecInfo.name}, PT: ${selectedCodecInfo.payloadType}`);

            setupUrl = selectedTrack.control; // RtspClient will resolve if relative to DESCRIBE URL
            if (!setupUrl) throw new Error("Selected audio track in SDP is missing 'a=control' attribute.");

            // Attempt SETUP with UDP first
            try {
                this.console.log(`Attempting UDP SETUP for track ${setupUrl}`);
                this.intercomUdpServer = await createBindZero('udp4');
                const clientRtpPortUdp = this.intercomUdpServer.port;
                const clientRtcpPortUdp = clientRtpPortUdp + 1;
                const udpTransportHeader = `RTP/AVP;unicast;client_port=${clientRtpPortUdp}-${clientRtcpPortUdp}`;

                const setupResponseUdp = await this.intercomClient.request('SETUP', { Transport: udpTransportHeader }, setupUrl);
                this.console.debug("Received UDP SETUP response:", setupResponseUdp.headers);
                confirmedTransportDict = parseSemicolonDelimited(setupResponseUdp.headers.transport);
                if (!confirmedTransportDict) throw new Error('UDP SETUP response missing Transport header.');

                currentSessionId = setupResponseUdp.headers.session?.split(';')[0];
                if (!currentSessionId) throw new Error('UDP SETUP response missing Session ID.');

                const serverPortStringUdp = confirmedTransportDict.server_port;
                if (!serverPortStringUdp) throw new Error('UDP SETUP response did not include server_port.');
                serverRtpPortUdp = parseInt(serverPortStringUdp.split('-')[0]);

                chosenTransport = 'udp';
                this.console.log(`UDP SETUP successful. Session: ${currentSessionId}, Server RTP: ${serverRtpPortUdp}`);
            } catch (udpError) {
                this.console.warn(`UDP SETUP failed for track ${setupUrl}: ${udpError.message}. Attempting TCP SETUP.`);
                if (this.intercomUdpServer) { // Clean up UDP server if it was created
                    this.intercomUdpServer.server.close();
                    this.intercomUdpServer = undefined;
                }
                // Reset session on client if partial from UDP attempt
                if (this.intercomClient.session) this.intercomClient.session = undefined;


                this.console.log(`Attempting TCP SETUP for track ${setupUrl}`);
                const tcpTransportHeader = `RTP/AVP/TCP;unicast;interleaved=0-1`;
                const setupResponseTcp = await this.intercomClient.request('SETUP', { Transport: tcpTransportHeader }, setupUrl);
                this.console.debug("Received TCP SETUP response:", setupResponseTcp.headers);
                confirmedTransportDict = parseSemicolonDelimited(setupResponseTcp.headers.transport);
                if (!confirmedTransportDict) throw new Error('TCP SETUP response missing Transport header.');

                currentSessionId = setupResponseTcp.headers.session?.split(';')[0];
                if (!currentSessionId) throw new Error('TCP SETUP response missing Session ID.');

                chosenTransport = 'tcp';
                this.console.log(`TCP SETUP successful. Session: ${currentSessionId}, Interleaved: ${confirmedTransportDict.interleaved || '0-1'}`);
            }
            this.intercomClient.session = currentSessionId; // Set session on the client instance for subsequent PLAY/TEARDOWN

            // SSRC
            if (confirmedTransportDict.ssrc) {
                const ssrcBuffer = Buffer.from(confirmedTransportDict.ssrc, 'hex');
                ssrcUnsigned = ssrcBuffer.readUint32BE(0);
            } else {
                ssrcUnsigned = crypto.randomBytes(4).readUint32BE(0);
            }
            this.console.log(`Using SSRC (unsigned): ${ssrcUnsigned} for transport ${chosenTransport}`);

            let ffmpegEncoderArguments: string[];
            switch (selectedCodecInfo.ffmpegEncodingName) {
                case 'aac':
                    ffmpegEncoderArguments = ['-acodec', 'aac', '-ar', selectedCodecInfo.clockRate.toString(), '-ac', selectedCodecInfo.channels.toString(), '-b:a', '64k', '-profile:a', 'aac_low'];
                    break;
                case 'pcm_alaw':
                    ffmpegEncoderArguments = ['-acodec', 'pcm_alaw', '-ar', selectedCodecInfo.clockRate.toString(), '-ac', selectedCodecInfo.channels.toString()];
                    break;
                default: // pcm_mulaw
                    ffmpegEncoderArguments = ['-acodec', 'pcm_mulaw', '-ar', selectedCodecInfo.clockRate.toString(), '-ac', selectedCodecInfo.channels.toString()];
                    break;
            }
            this.console.log(`FFmpeg encoder args for ${selectedCodecInfo.ffmpegEncodingName}: ${ffmpegEncoderArguments.join(' ')}`);

            let sequenceNumber = 0;
            this.intercomForwarder = await startRtpForwarderProcess(this.console, ffmpegInput, {
                audio: {
                    encoderArguments: ffmpegEncoderArguments, payloadType: selectedCodecInfo.payloadType,
                    ssrc: crypto.randomBytes(4).readInt32BE(0), // FFmpeg internal SSRC, we override packets.
                    onRtp: (rtp) => {
                        const packet = RtpPacket.deSerialize(rtp);
                        packet.header.payloadType = selectedCodecInfo.payloadType;
                        packet.header.ssrc = ssrcUnsigned;
                        packet.header.sequenceNumber = sequenceNumber;
                        sequenceNumber = nextSequenceNumber(sequenceNumber);
                        const finalPacket = packet.serialize();
                        if (chosenTransport === 'tcp') {
                            const audioChannel = confirmedTransportDict.interleaved?.split('-')[0] ? parseInt(confirmedTransportDict.interleaved.split('-')[0]) : 0;
                            this.intercomClient.send(finalPacket, audioChannel);
                        } else { // UDP
                            this.intercomUdpServer.server.send(finalPacket, serverRtpPortUdp, this.intercomClient.url.hostname);
                        }
                    },
                }
            });
            this.console.log('RTP forwarder process started.');

            this.intercomClient.client.on('close', () => { this.console.warn('RTSP client connection closed unexpectedly.'); this.stopIntercom(); });
            this.intercomForwarder.killPromise.finally(() => { this.console.log('RTP forwarder stopped.'); });

            this.console.log(`Sending RTSP PLAY for session ${currentSessionId} on track ${setupUrl}`);
            await this.intercomClient.request('PLAY', { Session: currentSessionId }, setupUrl);
            this.console.log('Intercom PLAY successful. Audio should be streaming.');

        } catch (e) {
            let errorDetails = e.message || 'Unknown error';
            if (e.rtspStatusCode) errorDetails += ` (RTSP Status Code: ${e.rtspStatusCode})`;
            this.console.error(`Failed during intercom operation: ${errorDetails}`, e.stack);
            await this.stopIntercom();
            throw e;
        }
    }

    async stopIntercom(): Promise<void> {
        this.console.log('Attempting to stop intercom session (minimal config)...');

        if (this.intercomForwarder) {
            this.console.log('Killing intercom RTP forwarder process.');
            try {
                this.intercomForwarder.kill();
                // Not awaiting killPromise here to make stopIntercom return faster.
                // killPromise is monitored in startIntercom if needed for other actions.
            } catch (e) {
                this.console.error("Error while killing intercom forwarder:", e.message);
            }
            this.intercomForwarder = undefined;
        } else {
            this.console.log('No active intercom RTP forwarder found.');
        }

        if (this.intercomClient) {
            this.console.log(`Intercom RTSP client found. Session ID: ${this.intercomClient.session || 'N/A'}.`);
            if (this.intercomClient.session && this.intercomClient.url) {
                try {
                    const teardownUrl = this.intercomClient.url.toString();
                    this.console.log(`Sending RTSP TEARDOWN for session ${this.intercomClient.session} to ${teardownUrl}`);
                    await this.intercomClient.request('TEARDOWN', { Session: this.intercomClient.session }, teardownUrl);
                    this.console.log(`RTSP TEARDOWN successful for session ${this.intercomClient.session}.`);
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
            } else {
                this.console.log('No active RTSP session or valid URL for intercom client. Skipping TEARDOWN command.');
            }
            try {
                this.intercomClient.safeTeardown();
                this.console.log('Intercom RTSP client torn down.');
            } catch (e) {
                this.console.error("Error during RTSP client safeTeardown:", e.message);
            }
            this.intercomClient = undefined;
        } else {
            this.console.log('No active intercom RTSP client found.');
        }

        if (this.intercomUdpServer) {
            this.console.log('Closing intercom UDP server.');
            try {
                this.intercomUdpServer.server.close();
            } catch (e) {
                this.console.error("Error while closing intercom UDP server:", e.message);
            }
            this.intercomUdpServer = undefined;
        } else {
            this.console.log('No active intercom UDP server found.');
        }
        this.console.log('Intercom stop sequence complete.');
    }

    updateDeviceInterfaces() {
        const interfaces: string[] = [...this.provider.getInterfaces()];
        const twoWayEnabled = this.storage.getItem('enableTwoWayAudio') === 'true';

        if (twoWayEnabled) {
            if (!interfaces.includes(ScryptedInterface.Intercom)) {
                interfaces.push(ScryptedInterface.Intercom);
            }
        } else {
            const intercomIndex = interfaces.indexOf(ScryptedInterface.Intercom);
            if (intercomIndex !== -1) {
                interfaces.splice(intercomIndex, 1);
            }
        }

        const currentType = deviceManager.getDeviceState(this.id)?.type || this.provider.getDefaultCameraType();
        this.provider.updateDevice(this.nativeId, this.name, interfaces, currentType);
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
        await super.putSetting(key, value);
        if (key === 'enableTwoWayAudio') {
            this.updateDeviceInterfaces();
        }
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
    getDefaultCameraType(): ScryptedDeviceType { // Ensure this exists
        return ScryptedDeviceType.Camera;
    }

    createCamera(nativeId: string): RtspCamera {
        return new RtspCamera(nativeId, this);
    }
}
