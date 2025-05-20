const socket = io("wss://abeens-fusion-ai-call-manager.hf.space", {
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 20000
});

let peerConnection;
let localStream;
let room;
let username;
let isInitiator = false;
let isConnected = false;

// Configuración de WebRTC con servidores STUN adicionales
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
};

// DOM Elements
const connectionStatusEl = document.getElementById('connectionStatus');
const roomInput = document.getElementById('room');
const usernameInput = document.getElementById('usernameInput');
const usernamePassword = document.getElementById('usernamePassword');
const joinBtn = document.getElementById('joinBtn');
const hangupBtn = document.getElementById('hangupBtn');
const audioContainer = document.getElementById('audioContainer');
const debugLog = document.getElementById('debugLog');
const transcriptionLog = document.getElementById('transcriptionLog');
const userInfo = document.getElementById('userInfo');
const usernameDisplay = document.getElementById('usernameDisplay');
const roomNumberDisplay = document.getElementById('roomNumber');

// Función para añadir mensajes al registro de depuración
function logMessage(message) {
    const timestamp = new Date().toLocaleTimeString();
    debugLog.innerHTML += `<div>[${timestamp}] ${message}</div>`;
    debugLog.scrollTop = debugLog.scrollHeight;
    console.log(`[${timestamp}] ${message}`);
}

// Función para añadir transcripciones
function addTranscription(participantId, text) {
    const timestamp = new Date().toLocaleTimeString();
    transcriptionLog.innerHTML += `<div>[${timestamp}] ${participantId}: ${text}</div>`;
    transcriptionLog.scrollTop = transcriptionLog.scrollHeight;
}

// Manejo de eventos de socket
socket.on('connect', () => {
    logMessage('✅ Conectado al servidor');
    updateConnectionStatus(true);
    joinBtn.disabled = false;
});

socket.on('connected', (data) => {
    logMessage(`ID de sesión: ${data.sid}`);
});

socket.on('disconnect', () => {
    logMessage('❌ Desconectado del servidor');
    updateConnectionStatus(false);
    endCall();
});

socket.on('connect_error', (error) => {
    logMessage(`Error de conexión: ${error.message}`);
    updateConnectionStatus(false);
});

socket.on('error', (error) => {
    logMessage(`Error del servidor: ${error.message}`);
    alert(`Error: ${error.message}`);
});

function updateConnectionStatus(connected) {
    isConnected = connected;
    connectionStatusEl.textContent = connected ? 'Conectado' : 'Desconectado';
    connectionStatusEl.className = connected ? 'status-connected' : 'status-disconnected';
}

function joinRoom() {
    room = roomInput.value.trim();
    username = usernameInput.value.trim();
    password = usernamePassword.value.trim();
    
    if (!room || !username) {
        alert("Por favor, ingresa un nombre de usuario y un ID de sala.");
        return;
    }

    if (!isConnected) {
        alert("No hay conexión con el servidor. Por favor, espera a que se reconecte.");
        return;
    }

    // Deshabilitar el botón de unirse mientras se procesa
    joinBtn.disabled = true;

    logMessage(`Intentando unirse a la sala: ${room} como ${username}`);
    
    // Configurar el manejador de error antes de emitir el evento join
    socket.once('error', (error) => {
        logMessage(`Error al unirse a la sala: ${error.message}`);
        // Limpiar la información del usuario si hay error
        userInfo.style.display = 'none';
        usernameDisplay.textContent = '';
        roomNumberDisplay.textContent = '';
        // Habilitar el botón de unirse nuevamente
        joinBtn.disabled = false;
        return;
    });

    // Configurar el manejador de mensaje exitoso
    socket.once('message', (data) => {
        if (data.msg && data.msg.includes('joined room')) {
            // Mostrar información del usuario solo si el join fue exitoso
            userInfo.style.display = 'block';
            usernameDisplay.textContent = username;
            roomNumberDisplay.textContent = room;
        }
    });

    // Configurar el manejador de verificación de password
    socket.once('verify_password_response', (response) => {
        if (response.success) {
            // Si el password es correcto, procedemos con el join
            socket.emit("join", { room, username, password });
            // Configurar el manejo de señales y iniciar la llamada
            setupSignalHandling();
            startCall(true);
        } else {
            logMessage(`Error: ${response.message}`);
            alert(response.message); // Mostrar el mensaje de error al usuario
            // Habilitar el botón de unirse nuevamente
            joinBtn.disabled = false;
        }
    });

    // Primero verificamos el password
    socket.emit('verify_password', { password });
}

function setupSignalHandling() {
    // Limpiar manejadores existentes para evitar duplicados
    socket.off('signal');
    socket.off('user_joined');
    socket.off('user_disconnected');
    socket.off('message');
    socket.off('transcription');
    
    socket.on('message', (data) => {
        logMessage(`Mensaje del servidor: ${data.msg}`);
    });

    socket.on('transcription', (data) => {
        if (data.text && data.text.trim()) {
            addTranscription(data.participant_id, data.text);
        }
    });

    socket.on("signal", async (data) => {
        try {
            logMessage(`Señal recibida tipo: ${data.type || 'ICE candidate'}`);
            
            if (data.type === "offer") {
                logMessage("Recibida oferta SDP");
                if (!peerConnection) {
                    await startCall(false);
                }
                
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
                logMessage("Descripción remota establecida, creando respuesta...");
                
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                
                logMessage("Enviando respuesta SDP al peer");
                socket.emit("signal", { room, type: "answer", answer });
            }
            else if (data.type === "answer") {
                logMessage("Recibida respuesta SDP");
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
                logMessage("Conexión establecida correctamente");
            } 
            else if (data.candidate) {
                logMessage("Recibido candidato ICE");
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (e) {
                    if (!peerConnection.remoteDescription) {
                        logMessage("Candidato ICE recibido antes de la descripción remota, guardando para más tarde");
                    } else {
                        throw e;
                    }
                }
            } 
            else if (data.type === "hangup") {
                logMessage("La otra persona colgó la llamada");
                endCall();
                alert("La otra persona colgó la llamada.");
            }
        } catch (error) {
            logMessage(`❌ Error en el manejo de señal: ${error.message}`);
            console.error("Error detallado:", error);
        }
    });

    socket.on("user_joined", (data) => {
        logMessage(`👤 Nuevo usuario en la sala: ${data.username || data.sid}`);
        hangupBtn.disabled = false;
    });

    socket.on("user_disconnected", (data) => {
        logMessage(`👤 Usuario desconectado: ${data.username || data.sid}`);
        endCall();
        alert("El otro usuario se ha desconectado.");
    });
}

async function startCall(initiator) {
    isInitiator = initiator;
    
    try {
        // Cerrar la conexión anterior si existe
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        
        logMessage(`Iniciando llamada como ${initiator ? 'iniciador' : 'receptor'}`);
        peerConnection = new RTCPeerConnection(configuration);
        
        // Configurar eventos de WebRTC
        setupPeerConnectionEvents();

        
        
        // Obtener y configurar stream local
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ 
                audio: true,
                video: false 
            });

            sendAudioOverWebSocket(localStream, socket.id); // Aquí envías el stream y tu id de socket
            
            logMessage("✅ Acceso al micrófono concedido");
            
            // Mostrar audio local
            const localAudio = document.createElement("audio");
            localAudio.srcObject = localStream;
            localAudio.id = "localAudio";
            localAudio.muted = true; // Importante para evitar retroalimentación
            audioContainer.appendChild(localAudio);
            
            localStream.getTracks().forEach(track => {
                logMessage(`Añadiendo pista de audio al peer connection: ${track.kind}`);
                peerConnection.addTrack(track, localStream);
            });
        } catch (mediaError) {
            logMessage(`❌ Error al acceder al micrófono: ${mediaError.message}`);
            alert(`Error al acceder al micrófono: ${mediaError.message}. Asegúrate de dar permisos.`);
            return;
        }
        
        if (isInitiator) {
            logMessage("Creando oferta SDP...");
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true
            });
            
            logMessage("Estableciendo descripción local...");
            await peerConnection.setLocalDescription(offer);
            
            logMessage("Enviando oferta SDP al servidor");
            socket.emit("signal", { room, type: "offer", offer });
        }
        
        hangupBtn.disabled = false;
    } catch (error) {
        logMessage(`❌ Error al iniciar la llamada: ${error.message}`);
        console.error("Error detallado:", error);
        alert(`Error al iniciar la llamada: ${error.message}`);
    }
}

function sendAudioOverWebSocket(stream, participantId) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const mediaStreamSource = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(2048, 1, 1); // Reducimos el tamaño del buffer para más frecuencia

    let audioBuffer = [];
    let isRecording = false;
    let silenceCounter = 0;
    const SILENCE_THRESHOLD = 500; // Umbral de silencio más bajo
    const MAX_SILENCE_FRAMES = 10; // Número de frames de silencio antes de enviar

    mediaStreamSource.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (event) => {
        const audioData = event.inputBuffer.getChannelData(0);
        const int16Array = float32ToInt16(audioData);
        
        // Detectar si hay sonido
        const hasSound = int16Array.some(value => Math.abs(value) > SILENCE_THRESHOLD);
        
        if (hasSound) {
            if (!isRecording) {
                isRecording = true;
                audioBuffer = [];
                silenceCounter = 0;
            }
            audioBuffer.push(int16Array);
            silenceCounter = 0;
        } else if (isRecording) {
            silenceCounter++;
            
            // Si detectamos silencio, seguimos grabando un poco más para capturar el final de la frase
            if (silenceCounter >= MAX_SILENCE_FRAMES) {
                if (audioBuffer.length > 0) {
                    // Combinar todos los chunks de audio
                    const totalLength = audioBuffer.reduce((acc, chunk) => acc + chunk.length, 0);
                    const combinedBuffer = new Int16Array(totalLength);
                    
                    let offset = 0;
                    audioBuffer.forEach(chunk => {
                        combinedBuffer.set(chunk, offset);
                        offset += chunk.length;
                    });
                    
                    // Enviar el audio
                    socket.emit('audio_chunk', {
                        participant_id: username,
                        audio_data: combinedBuffer.buffer,
                        room: room
                    });
                    
                    // Limpiar el buffer
                    audioBuffer = [];
                    isRecording = false;
                    silenceCounter = 0;
                }
            } else {
                // Seguir acumulando audio durante el silencio
                audioBuffer.push(int16Array);
            }
        }
    };
}

// Conversión de audio Float32 a Int16 mejorada
function float32ToInt16(buffer) {
    const int16Array = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        // Aplicar un poco de ganancia para mejorar la detección
        const sample = Math.min(1, Math.max(-1, buffer[i] * 1.5));
        int16Array[i] = sample * 0x7FFF;
    }
    return int16Array;
}

function setupPeerConnectionEvents() {
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            logMessage("Generado candidato ICE local, enviando...");
            socket.emit("signal", { room, candidate: event.candidate });
        } else {
            logMessage("Recolección de candidatos ICE completada");
        }
    };

    peerConnection.ontrack = (event) => {
        logMessage("✅ Pista de audio remota recibida");
        const remoteAudio = document.createElement("audio");
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.id = "remoteAudio";
        remoteAudio.autoplay = true;
        audioContainer.appendChild(remoteAudio);
    };

    peerConnection.oniceconnectionstatechange = () => {
        logMessage(`Estado de conexión ICE: ${peerConnection.iceConnectionState}`);
        if (peerConnection.iceConnectionState === 'failed') {
            logMessage("Reiniciando recolección de candidatos ICE");
            peerConnection.restartIce();
        }
    };

    peerConnection.onconnectionstatechange = () => {
        logMessage(`Estado de conexión: ${peerConnection.connectionState}`);
        if (peerConnection.connectionState === 'connected') {
            logMessage("✅ ¡Conexión establecida con éxito!");
        } else if (peerConnection.connectionState === 'failed') {
            logMessage("❌ La conexión ha fallado");
            endCall();
            alert("La conexión ha fallado. Por favor, intenta de nuevo.");
        }
    };
    
    peerConnection.onsignalingstatechange = () => {
        logMessage(`Estado de señalización: ${peerConnection.signalingState}`);
    };
}

function hangUp() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    // Get the transcription log content
    const callContent = transcriptionLog.innerHTML;
    
    // Send the call content to the server
    socket.emit('call_ended', {
        room: room,
        content: callContent
    });
    
    // Clear the audio container
    audioContainer.innerHTML = '';
    
    // Reset UI
    hangupBtn.disabled = true;
    joinBtn.disabled = false;
    
    // Clear room and username
    room = null;
    username = null;
    
    // Hide user info
    userInfo.style.display = 'none';
    usernameDisplay.textContent = '';
    roomNumberDisplay.textContent = '';
    
    logMessage("Llamada finalizada");
}

function endCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
        logMessage("Conexión peer cerrada");
    }

    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            logMessage(`Pista de audio local detenida: ${track.kind}`);
        });
        localStream = null;
    }

    // Limpiar contenedor de audio
    audioContainer.innerHTML = "";
    hangupBtn.disabled = true;
    logMessage("Llamada finalizada");
}

// Inicializar UI cuando la página cargue
document.addEventListener('DOMContentLoaded', () => {
    updateConnectionStatus(false);
    hangupBtn.disabled = true;
    
    // Agregar event listeners
    joinBtn.addEventListener('click', joinRoom);
    hangupBtn.addEventListener('click', hangUp);
    
    // Crear contenedor de depuración si no existe
    if (!debugLog) {
        const debugLogContainer = document.createElement('div');
        debugLogContainer.id = 'debugLog';
        debugLogContainer.className = 'debug-log';
        document.body.appendChild(debugLogContainer);
    }
    
    logMessage("Aplicación inicializada, esperando conexión al servidor...");
});

// Detectar cuando la página se cierra para limpiar recursos
window.addEventListener('beforeunload', () => {
    hangUp();
    if (socket.connected) {
        socket.disconnect();
    }
});
