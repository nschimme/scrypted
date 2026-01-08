import { timeoutPromise } from '@scrypted/common/src/promise-utils';
import sdk, { Intercom, MediaObject, MediaStreamUrl, PictureOptions, RequestPictureOptions, ResponseMediaStreamOptions, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, SettingValue, UrlMediaStreamOptions as ScryptedUrlMediaStreamOptions } from "@scrypted/sdk"; // Added Intercom, ScryptedDeviceType, UrlMediaStreamOptions as ScryptedUrlMediaStreamOptions
import url from 'url';
import { CameraBase, CameraProviderBase, UrlMediaStreamOptions } from "../../ffmpeg-camera/src/common"; // This UrlMediaStreamOptions is from ffmpeg-camera

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

        // Two-Way Audio Settings
        const twoWayAudioSettings: Setting[] = [
            {
                key: 'enableTwoWayAudio',
                title: 'Enable Two-Way Audio (Experimental)',
                description: 'Enables experimental two-way audio. The plugin will attempt to auto-negotiate transport (UDP then TCP) and codec (AAC > PCMU > PCMA) based on camera capabilities advertised via SDP from the selected Intercom SDP Source Stream.',
                type: 'boolean',
                value: this.storage.getItem('enableTwoWayAudio') === 'true',
            },
        ];

        // Dynamically build choices for intercomSdpSourceStreamId
        const streamChoices = [{ title: "Default (Use First Configured Stream)", value: "__default__" }];
        try {
            // We need to call getVideoStreamOptions() which might be overridden by RtspSmartCamera
            // Ensure this method is available or call a more base version if RtspCamera itself needs these settings.
            // For now, assuming this.getVideoStreamOptions() works or RtspSmartCamera overrides getOtherSettings.
            // A safer way might be to get raw stream URLs if this is called on RtspCamera base.
            // However, UrlMediaStreamOptions (which getVideoStreamOptions returns) has id and name.
            const currentStreams: ScryptedUrlMediaStreamOptions[] = await this.getVideoStreamOptions() || [];
            currentStreams.forEach(stream => {
                streamChoices.push({ title: stream.name || stream.id, value: stream.id });
            });
        } catch (e) {
            this.console.error("Error fetching streams for Intercom SDP Source setting:", e);
        }

        twoWayAudioSettings.push({
            key: 'intercomSdpSourceStreamId',
            title: 'Intercom SDP Source Stream',
            description: "Select which configured stream should be used to get the SDP for discovering two-way audio capabilities. 'Default' uses the first configured stream.",
            type: 'string', // Dropdown is represented as string type with choices
            choices: streamChoices,
            value: this.storage.getItem('intercomSdpSourceStreamId') || "__default__",
        });

        twoWayAudioSettings.forEach(s => s.subgroup = 'Two-Way Audio');
        ret.push(...twoWayAudioSettings);

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
    // Placeholders for intercom state
    intercomClient: any;
    intercomForwarder: any;
    // intercomClient, intercomForwarder, intercomUdpServer types defined from previous attempts, ensure they are correct.
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
        this.console.log('Attempting to start intercom (using selected stream for DESCRIBE)...');
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

        // Determine describeUrl based on intercomSdpSourceStreamId setting
        let describeUrl: string;
        const allStreamOptions = await this.getVideoStreamOptions();
        if (!allStreamOptions || allStreamOptions.length === 0) {
            this.console.error('No RTSP streams configured for this camera.');
            throw new Error('No RTSP streams configured for this camera.');
        }

        const selectedStreamId = this.storage.getItem('intercomSdpSourceStreamId') || "__default__";
        let streamSourceDescription: string;

        if (selectedStreamId === "__default__") {
            describeUrl = allStreamOptions[0].url;
            streamSourceDescription = `default (first configured stream: ${allStreamOptions[0].name || allStreamOptions[0].id})`;
        } else {
            const selectedOption = allStreamOptions.find(s => s.id === selectedStreamId);
            if (selectedOption) {
                describeUrl = selectedOption.url;
                streamSourceDescription = `selected stream: ${selectedOption.name || selectedOption.id}`;
            } else {
                this.console.warn(`Configured Intercom SDP Source Stream ID '${selectedStreamId}' not found. Falling back to default (first stream).`);
                describeUrl = allStreamOptions[0].url;
                streamSourceDescription = `default (first configured stream after invalid selection: ${allStreamOptions[0].name || allStreamOptions[0].id})`;
            }
        }

        if (!describeUrl) { // Should be caught by allStreamOptions check, but as a safeguard
             this.console.error('Could not determine a valid RTSP URL for DESCRIBE.');
             throw new Error('Could not determine a valid RTSP URL for DESCRIBE.');
        }

        this.console.log(`Using URL for DESCRIBE (${streamSourceDescription}): ${describeUrl}`);
        const describeUrlWithCreds = this.addRtspCredentials(describeUrl);

        this.intercomClient = new RtspClient(describeUrlWithCreds);
        this.intercomClient.console = this.console;

        // Declare variables needed throughout the try block
        let sdp: string;
        let selectedTrack: MSection = null;
        let selectedCodecInfo: { name: string, payloadType: number, clockRate: number, ffmpegEncodingName: string, channels: number } = null;
        let setupControlUrl: string;
        let currentSessionId: string;
        let serverRtpPortUdp: number;
        let ssrcUnsigned: number;
        let chosenTransport: 'udp' | 'tcp';
        let confirmedTransportDict: ReturnType<typeof parseSemicolonDelimited>;

        try {
            this.console.log(`Sending DESCRIBE request to ${describeUrlWithCreds}`);
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
                throw new Error("Camera does not advertise a supported audio input stream (AAC, PCMU, PCMA with a=sendonly/a=sendrecv) in its SDP.");
            }
            this.console.log(`Selected audio input track: ${selectedTrack.control || 'N/A (base URL assumed)'}, Codec: ${selectedCodecInfo.name}, PT: ${selectedCodecInfo.payloadType}`);

            setupControlUrl = selectedTrack.control || ''; // if control is not present, use base URL (empty string for RtspClient relative path)
                                                       // RtspClient resolves '' or relative paths against its base URL.

            // Attempt SETUP with UDP first
            try {
                this.console.log(`Attempting UDP SETUP for track control: '${setupControlUrl}'`);
                this.intercomUdpServer = await createBindZero('udp4');
                const clientRtpPortUdp = this.intercomUdpServer.port;
                const clientRtcpPortUdp = clientRtpPortUdp + 1;
                const udpTransportHeader = `RTP/AVP;unicast;client_port=${clientRtpPortUdp}-${clientRtcpPortUdp}`;

                const setupResponseUdp = await this.intercomClient.request('SETUP', { Transport: udpTransportHeader }, setupControlUrl);
                this.console.debug("Received UDP SETUP response headers:", setupResponseUdp.headers);
                confirmedTransportDict = parseSemicolonDelimited(setupResponseUdp.headers.transport);
                if (!confirmedTransportDict) throw new Error('UDP SETUP response missing or invalid Transport header.');

                currentSessionId = setupResponseUdp.headers.session?.split(';')[0];
                if (!currentSessionId) throw new Error('UDP SETUP response missing Session ID.');

                const serverPortStringUdp = confirmedTransportDict.server_port;
                if (!serverPortStringUdp) throw new Error('UDP SETUP response did not include server_port.');
                serverRtpPortUdp = parseInt(serverPortStringUdp.split('-')[0]);

                chosenTransport = 'udp';
                this.console.log(`UDP SETUP successful. Session: ${currentSessionId}, Server RTP Port: ${serverRtpPortUdp}`);
            } catch (udpError) {
                this.console.warn(`UDP SETUP failed for track control '${setupControlUrl}': ${udpError.message}. Attempting TCP SETUP.`);
                if (this.intercomUdpServer) {
                    this.intercomUdpServer.server.close();
                    this.intercomUdpServer = undefined;
                }
                if (this.intercomClient.session) this.intercomClient.session = undefined; // Reset session before TCP attempt

                this.console.log(`Attempting TCP SETUP for track control: '${setupControlUrl}'`);
                const tcpTransportHeader = `RTP/AVP/TCP;unicast;interleaved=0-1`; // Propose channels 0-1
                const setupResponseTcp = await this.intercomClient.request('SETUP', { Transport: tcpTransportHeader }, setupControlUrl);
                this.console.debug("Received TCP SETUP response headers:", setupResponseTcp.headers);
                confirmedTransportDict = parseSemicolonDelimited(setupResponseTcp.headers.transport);
                if (!confirmedTransportDict) throw new Error('TCP SETUP response missing or invalid Transport header.');

                currentSessionId = setupResponseTcp.headers.session?.split(';')[0];
                if (!currentSessionId) throw new Error('TCP SETUP response missing Session ID.');

                // Verify TCP setup was accepted with interleaved
                if (!confirmedTransportDict.interleaved) {
                    this.console.warn('TCP SETUP response did not confirm interleaved mode in Transport header. Proceeding with 0-1.');
                    // Ensure confirmedTransportDict has a default for onRtp logic later
                    confirmedTransportDict.interleaved = confirmedTransportDict.interleaved || '0-1';
                }

                chosenTransport = 'tcp';
                this.console.log(`TCP SETUP successful. Session: ${currentSessionId}, Interleaved: ${confirmedTransportDict.interleaved}`);
            }
            this.intercomClient.session = currentSessionId;

            if (confirmedTransportDict.ssrc) {
                const ssrcBuffer = Buffer.from(confirmedTransportDict.ssrc, 'hex');
                ssrcUnsigned = ssrcBuffer.readUint32BE(0);
            } else {
                ssrcUnsigned = crypto.randomBytes(4).readUint32BE(0);
            }
            this.console.log(`Using SSRC (unsigned): ${ssrcUnsigned} for ${chosenTransport} transport.`);

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
                    ssrc: crypto.randomBytes(4).readInt32BE(0),
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

            this.intercomClient.client.on('close', () => { this.console.warn('RTSP client connection closed unexpectedly during active intercom.'); this.stopIntercom(); });
            this.intercomForwarder.killPromise.finally(() => { this.console.log('RTP forwarder process stopped.'); /* May need to call stopIntercom if not already stopping */ });

            // Use setupControlUrl for PLAY, as it's the track-specific control URL
            const playUrl = setupControlUrl;
            this.console.log(`Sending RTSP PLAY for session ${currentSessionId} on track control URL: '${playUrl}'`);
            await this.intercomClient.request('PLAY', { Session: currentSessionId }, playUrl);
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
        this.console.warn("RTSP stopIntercom called. Basic cleanup will be performed.");
        if (this.intercomForwarder && typeof this.intercomForwarder.kill === 'function') this.intercomForwarder.kill();
        if (this.intercomClient && typeof this.intercomClient.safeTeardown === 'function') this.intercomClient.safeTeardown();
        if (this.intercomUdpServer && typeof this.intercomUdpServer.server?.close === 'function') this.intercomUdpServer.server.close();
        this.intercomForwarder = undefined;
        this.intercomClient = undefined;
        this.intercomUdpServer = undefined;
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
        if (key === 'enableTwoWayAudio' || key === 'intercomSdpSourceStreamId') { // Also update if source stream changes? Not strictly necessary for interfaces.
            this.updateDeviceInterfaces(); // Mainly for enableTwoWayAudio
        }
        // For other settings changes that might affect intercom if it's running,
        // it might need to be restarted. For now, only interface update on enable/disable.
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
    getDefaultCameraType(): ScryptedDeviceType {
        return ScryptedDeviceType.Camera;
    }

    createCamera(nativeId: string): RtspCamera {
        return new RtspCamera(nativeId, this);
    }
}
