/**
 * RDT-Client (émulation qBittorrent WebUI API).
 * Résout le faux-positif à l'ajout (réponse 200 vide / formatée différemment)
 * et le statut "En pause" lors de la fin de téléchargement (débloque l'import automatique).
 */

import type { TorrentClientDriver, TorrentInfo, DownloadOptions, ClientConfig } from './index.js'
import { clientFetch } from './index.js'
import { logger } from '../logger.js'

/**
 * Validation de la réponse d'ajout :
 * - qBittorrent classique renvoie « Ok. »
 * - RDT-Client (ASP.NET Core) renvoie souvent HTTP 200 avec un corps vide, ou « Ok », ou un JSON.
 */
function isRdtAddSuccess(res: Response, text: string): boolean {
    if (res.ok) {
        const trimmed = text.trim()
        if (trimmed === 'Ok.' || trimmed === 'Ok' || trimmed === '') return true
        try {
            const json = JSON.parse(text)
            if (typeof json?.success_count === 'number') return json.success_count > 0
            if (json?.success === true || json?.result === true || json?.status === 'success') return true
        } catch {}

        const lower = trimmed.toLowerCase()
        if (!lower.includes('fail') && !lower.includes('error')) {
            return true
        }
    }
    return false
}

/**
 * Mapping des statuts de RDT-Client vers les états internes FanKarr :
 * RDT-Client ne seed pas sur le réseau BitTorrent une fois téléchargé depuis Real-Debrid.
 * Son état passe à "Finished" côté RDT, ce qui est exposé via l'API qBittorrent sous
 * 'pausedUP', 'stoppedUP', 'finished', 'completed' ou 'uploading'.
 * Dans FanKarr, l'état déclencheur de l'import automatique est 'seeding'.
 */
function mapState(state: string, progress?: number): TorrentInfo['state'] {
    // En cours de téléchargement
    if (['downloading', 'metaDL', 'queuedDL', 'stalledDL', 'forcedDL'].includes(state)) return 'downloading'

    // Téléchargement terminé / prêt pour l'import automatique
    if ([
        'uploading', 'queuedUP', 'stalledUP', 'forcedUP',
        'pausedUP', 'stoppedUP',
        'finished', 'completed', 'complete',
    ].includes(state)) {
        return 'seeding'
    }

    // Si le progrès est complet (100% ou 1.0) et sans erreur
    if (progress != null && (progress >= 100 || progress >= 1) && !['error', 'missingFiles', 'checkingDL'].includes(state)) {
        if (!['pausedDL', 'stoppedDL'].includes(state)) {
            return 'seeding'
        }
    }

    // Téléchargement réellement mis en pause avant complétion
    if (['pausedDL', 'stoppedDL'].includes(state)) return 'paused'

    // Vérification
    if (['checkingDL', 'checkingUP', 'checkingResumeData', 'checking'].includes(state)) return 'checking'

    // Erreurs
    if (state === 'error' || state === 'missingFiles') return 'error'

    return 'unknown'
}

async function rdtAuth(config: ClientConfig): Promise<Record<string, string>> {
    if (config.apiKey) {
        return { Authorization: `Bearer ${config.apiKey}` }
    }
    const cookie = await rdtLogin(config)
    return cookie ? { Cookie: cookie } : {}
}

async function rdtLogin(config: ClientConfig): Promise<string> {
    const form = new URLSearchParams()
    form.append('username', String(config.username ?? ''))
    form.append('password', String(config.password ?? ''))

    const res = await clientFetch(config, `${config.url}/api/v2/auth/login`, {
        method : 'POST',
        body   : form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })

    const text = await res.text()
    if (!res.ok) throw new Error(`Échec de la connexion : ${text.trim() || `HTTP ${res.status}`}`)
    if (text.trim() === 'Fails.') throw new Error('Identifiants incorrects (vérifiez le nom d\'utilisateur et le mot de passe)')

    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0].trim()
    return cookie
}

/**
 * Échappement d'une chaîne pour utilisation dans une expression régulière C# .NET.
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Construit une regex case-insensitive compatible C# pour cibler un ou plusieurs fichiers précis.
 */
function makeIncludeRegex(fileNames: string | string[]): string {
    const list = Array.isArray(fileNames) ? fileNames : [fileNames]
    if (list.length === 1) {
        return `(?i)${escapeRegex(list[0])}`
    }
    const escaped = list.map(f => escapeRegex(f)).join('|')
    return `(?i)(${escaped})`
}

/**
 * Analyse succincte d'un fichier .torrent bencodé pour extraire le nom du fichier à l'index donné.
 */
function extractTorrentFileName(buffer: ArrayBuffer, targetIndex: number): string | null {
    try {
        const bytes = new Uint8Array(buffer)
        let pos = 0
        const decoder = new TextDecoder('utf-8', { fatal: false })

        function parse(): any {
            if (pos >= bytes.length) return null
            const b = bytes[pos]
            if (b === 0x69) { // 'i'
                pos++
                const end = bytes.indexOf(0x65, pos)
                if (end === -1) return null
                const n = parseInt(decoder.decode(bytes.subarray(pos, end)), 10)
                pos = end + 1
                return n
            }
            if (b === 0x6c) { // 'l'
                pos++
                const list: any[] = []
                while (pos < bytes.length && bytes[pos] !== 0x65) {
                    list.push(parse())
                }
                pos++
                return list
            }
            if (b === 0x64) { // 'd'
                pos++
                const dict: Record<string, any> = {}
                while (pos < bytes.length && bytes[pos] !== 0x65) {
                    const k = parse()
                    const v = parse()
                    if (typeof k === 'string') dict[k] = v
                }
                pos++
                return dict
            }
            if (b >= 0x30 && b <= 0x39) { // '0'-'9'
                const colon = bytes.indexOf(0x3a, pos)
                if (colon === -1) return null
                const len = parseInt(decoder.decode(bytes.subarray(pos, colon)), 10)
                pos = colon + 1
                const strBytes = bytes.subarray(pos, pos + len)
                pos += len
                return decoder.decode(strBytes)
            }
            return null
        }

        const torrent = parse()
        const info = torrent?.info
        if (!info) return null

        if (Array.isArray(info.files)) {
            const fileEntry = info.files[targetIndex]
            if (fileEntry) {
                if (Array.isArray(fileEntry.path)) {
                    return fileEntry.path[fileEntry.path.length - 1] || null
                }
                if (typeof fileEntry.path === 'string') {
                    return fileEntry.path.split(/[\\/]/).pop() || null
                }
            }
        } else if (typeof info.name === 'string' && targetIndex === 0) {
            return info.name
        }
        return null
    } catch {
        return null
    }
}

/**
 * Récupère les paramètres de RDT-Client via son API native GET /Api/Settings.
 */
async function rdtGetSettings(config: ClientConfig, authHeaders: Record<string, string>): Promise<Record<string, any>> {
    try {
        const res = await clientFetch(config, `${config.url}/Api/Settings`, { headers: authHeaders })
        if (!res.ok) return {}
        const list: any[] = await res.json()
        const map: Record<string, any> = {}
        if (Array.isArray(list)) {
            for (const item of list) {
                const k = item.Key ?? item.key
                const v = item.Value ?? item.value
                if (k) map[k] = v
            }
        }
        return map
    } catch {
        return {}
    }
}

async function rdtGetTorrent(config: ClientConfig, authHeaders: Record<string, string>, hash: string): Promise<any | null> {
    try {
        const res = await clientFetch(config, `${config.url}/api/v2/torrents/info?hashes=${hash}`, {
            headers: authHeaders,
        })
        if (!res.ok) return null
        const list = await res.json()
        if (Array.isArray(list) && list.length > 0) return list[0]
        return null
    } catch {
        return null
    }
}

async function rdtDeleteTorrent(config: ClientConfig, authHeaders: Record<string, string>, hash: string, deleteFiles = false): Promise<void> {
    const params = new URLSearchParams({ hashes: hash, deleteFiles: deleteFiles ? 'true' : 'false' })
    await clientFetch(config, `${config.url}/api/v2/torrents/delete`, {
        method : 'POST',
        body   : params,
        headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    })
}

async function rdtApplyFilePriority(
    config   : ClientConfig,
    hash     : string,
    fileIndex: number,
): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(r => setTimeout(r, attempt === 0 ? 200 : 1000))
        try {
            const authH = await rdtAuth(config)
            const res = await clientFetch(config, `${config.url}/api/v2/torrents/files?hash=${hash}`, {
                headers: authH,
            })
            if (!res.ok) continue
            const files: any[] = await res.json()
            if (!Array.isArray(files) || files.length === 0) continue

            if (fileIndex >= files.length) {
                logger.warn('rdtclient', `Fichier n° ${fileIndex} hors limites (${files.length} fichiers dans le torrent)`)
                return
            }

            const headers = { ...authH, 'Content-Type': 'application/x-www-form-urlencoded' }
            const isInitialState = files.every((f: any) => (f.priority ?? 1) > 0)

            if (isInitialState) {
                const unwanted = files.map((_, i) => i).filter(i => i !== fileIndex)
                if (unwanted.length > 0) {
                    const body = new URLSearchParams({ hash, id: unwanted.join('|'), priority: '0' })
                    const r = await clientFetch(config, `${config.url}/api/v2/torrents/filePrio`, { method: 'POST', body, headers })
                    if (!r.ok) { logger.debug('rdtclient', `filePrio 0 renvoyé HTTP ${r.status}`); continue }
                }
            }

            const r2 = await clientFetch(config, `${config.url}/api/v2/torrents/filePrio`, {
                method: 'POST',
                body   : new URLSearchParams({ hash, id: String(fileIndex), priority: '1' }),
                headers,
            })
            if (!r2.ok) { logger.debug('rdtclient', `filePrio 1 renvoyé HTTP ${r2.status}`); continue }

            logger.info('rdtclient', `Fichier n° ${fileIndex} sélectionné pour ${hash.slice(0, 8)}…`)
            return
        } catch (err) {
            logger.debug('rdtclient', `Tentative priorité fichier : ${err instanceof Error ? err.message : err}`)
        }
    }

    logger.warn('rdtclient', `Métadonnées des fichiers du torrent ${hash.slice(0, 8)}… non configurées (le téléchargement global continue)`)
}

const RDTClient: TorrentClientDriver = {
    definition: {
        id    : 'rdtclient',
        label : 'RDT-Client',
        fields: [
            { key: 'url',      label: 'URL de la WebUI',  type: 'url',      placeholder: 'http://localhost:6500', required: true },
            { key: 'username', label: 'Nom d\'utilisateur', type: 'text',   placeholder: 'admin',                required: false },
            { key: 'password', label: 'Mot de passe',     type: 'password', placeholder: '••••••••',             required: false },
            { key: 'category', label: 'Catégorie',        type: 'text',     placeholder: 'fankai',               required: false, default: 'fankai' },
            { key: 'savePath',   label: 'Dossier de téléchargement', type: 'text', placeholder: '/downloads/fankai',  required: false },
            { key: 'remotePath', label: 'Dossier vu par le client',  type: 'text', placeholder: '/downloads',         required: false },
            { key: 'localPath',  label: 'Dossier vu par FanKarr',    type: 'text', placeholder: '/mnt/nas/downloads', required: false },
            { key: 'ignoreCertificateErrors', label: 'Ignorer les erreurs de certificat SSL', type: 'boolean', required: false },
        ],
    },

    async test(config) {
        try {
            const authH = await rdtAuth(config)
            const res = await clientFetch(config, `${config.url}/api/v2/app/version`, { headers: authH })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            logger.info('rdtclient', `Test de connexion réussi sur ${config.url}`)
            return { ok: true, message: 'Connexion réussie' }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Erreur inattendue, consultez les journaux'
            logger.warn('rdtclient', `Échec du test de connexion sur ${config.url} : ${msg}`)
            return { ok: false, message: msg }
        }
    },

    async healthcheck(config) {
        try {
            const authH = await rdtAuth(config)
            const res = await clientFetch(config, `${config.url}/api/v2/app/version`, {
                headers: authH,
            })
            if (!res.ok) return { online: false }
            const version = (await res.text()).trim()
            logger.debug('rdtclient', `Client en ligne (version ${version || 'détectée'})`)
            return { online: true, version: version || undefined }
        } catch (err) {
            logger.debug('rdtclient', `Client injoignable : ${err instanceof Error ? err.message : err}`)
            return { online: false }
        }
    },

    async list(config, category) {
        const authH  = await rdtAuth(config)
        const params = new URLSearchParams()
        if (category) params.set('category', category)
        const res = await clientFetch(config, `${config.url}/api/v2/torrents/info?${params}`, {
            headers: authH,
        })
        if (!res.ok) throw new Error(`Liste des torrents inaccessible (HTTP ${res.status})`)
        const data: any[] = await res.json()

        return data.map(t => {
            const progressVal = typeof t.progress === 'number' ? Math.round(t.progress * 100) : 0
            return {
                hash      : t.hash,
                name      : t.name,
                state     : mapState(t.state, progressVal),
                progress  : progressVal,
                size      : t.size ?? 0,
                downloaded: t.downloaded ?? 0,
                uploaded  : t.uploaded ?? 0,
                ratio     : Math.round((t.ratio ?? 0) * 100) / 100,
                speed     : t.dlspeed ?? 0,
                upspeed   : t.upspeed ?? 0,
                eta       : t.eta ?? -1,
                save_path : t.save_path ?? '',
                category  : t.category ?? '',
                // RDT-Client ne gère pas de progression granulaire par fichier fiable via son API d'émulation.
                // Laisser files undefined permet au worker d'organisation de vérifier directement la présence
                // des fichiers sur le disque (comme pour Deluge, uTorrent, Synology) et évite d'ignorer
                // à tort les épisodes téléchargés.
                files     : undefined,
            } satisfies TorrentInfo
        })
    },

    async add(config, url, options?: DownloadOptions) {
        const authH = await rdtAuth(config)

        const hash = (options?.infohash?.toLowerCase() ?? null)
                  || url.match(/xt=urn:btih:([a-fA-F0-9]{40,})/i)?.[1]?.toLowerCase()
                  || options?.magnet?.match(/xt=urn:btih:([a-fA-F0-9]{40,})/i)?.[1]?.toLowerCase()
                  || null

        const hasFileFilter = (options?.file_index != null)
            || (options?.file_path != null)
            || (Array.isArray(options?.file_indices) && options.file_indices.length > 0)
            || (Array.isArray(options?.file_paths) && options.file_paths.length > 0)

        if (hash) {
            const existingTorrent = await rdtGetTorrent(config, authH, hash)
            if (existingTorrent) {
                const progressVal = typeof existingTorrent.progress === 'number' ? Math.round(existingTorrent.progress * 100) : 0
                const state = mapState(existingTorrent.state, progressVal)
                const isFinished = state === 'seeding' || (existingTorrent.progress >= 1)

                if (isFinished) {
                    logger.info('rdtclient', `Torrent ${hash.slice(0, 8)}… déjà terminé dans RDT-Client : renouvellement pour nouveaux épisodes (fichiers existants conservés sur disque)`)
                    await rdtDeleteTorrent(config, authH, hash, false).catch(() => {})
                } else {
                    logger.info('rdtclient', `Torrent ${hash.slice(0, 8)}… déjà en cours dans RDT-Client`)
                    const indices = Array.isArray(options?.file_indices) && options.file_indices.length > 0
                        ? options.file_indices
                        : (options?.file_index != null ? [options.file_index] : [])
                    for (const idx of indices) {
                        rdtApplyFilePriority(config, hash, idx).catch(() => {})
                    }
                    return
                }
            }
        }

        if (hasFileFilter) {
            let knownHashes: Set<string> = new Set()
            if (!hash) {
                try {
                    const lr = await clientFetch(config, `${config.url}/api/v2/torrents/info`, { headers: authH })
                    if (lr.ok) knownHashes = new Set((await lr.json()).map((t: any) => String(t.hash).toLowerCase()))
                } catch {}
            }

            const isMagnet = url.startsWith('magnet:')
            let torrentBytes: ArrayBuffer | null = null

            if (!isMagnet) {
                logger.debug('rdtclient', `Téléchargement du fichier .torrent par FanKarr : ${url.slice(0, 120)}`)
                const torrentRes = await fetch(url, { headers: { 'User-Agent': 'FanKarr/1.0' } })
                if (!torrentRes.ok) throw new Error(`Impossible de télécharger le fichier .torrent (HTTP ${torrentRes.status}) : ${url}`)
                torrentBytes = await torrentRes.arrayBuffer()
            }

            // Détermination des noms de fichiers ciblés (unique ou multiple)
            const targetFileNames: string[] = []

            if (Array.isArray(options?.file_paths) && options.file_paths.length > 0) {
                for (const fp of options.file_paths) {
                    const name = (fp || '').split(/[\\/]/).pop()
                    if (name && !targetFileNames.includes(name)) targetFileNames.push(name)
                }
            } else if (options?.file_path) {
                const name = options.file_path.split(/[\\/]/).pop()
                if (name) targetFileNames.push(name)
            }

            if (targetFileNames.length === 0 && torrentBytes) {
                const indices = Array.isArray(options?.file_indices) && options.file_indices.length > 0
                    ? options.file_indices
                    : (options?.file_index != null ? [options.file_index] : [])
                for (const idx of indices) {
                    const name = extractTorrentFileName(torrentBytes, idx)
                    if (name && !targetFileNames.includes(name)) targetFileNames.push(name)
                }
            }

            const includeRegex = targetFileNames.length > 0 ? makeIncludeRegex(targetFileNames) : null

            let uploadSuccess = false

            // Tentative 1 : Upload via l'API native RDT-Client avec includeRegex pour que Real-Debrid
            // ne sélectionne et ne télécharge QUE les fichiers précis du pack.
            if (includeRegex) {
                try {
                    const settings = await rdtGetSettings(config, authH)
                    const torrentPayload: Record<string, any> = {
                        category            : config.category ?? 'fankai',
                        downloadClient      : settings['DownloadClient:Client'] ?? 0,
                        hostDownloadAction  : settings['Integrations:Default:HostDownloadAction'] ?? 0,
                        downloadAction      : (settings['Integrations:Default:OnlyDownloadAvailableFiles'] ?? false) ? 1 : 0,
                        downloadMinSize     : settings['Integrations:Default:MinFileSize'] ?? 0,
                        torrentRetryAttempts: settings['Integrations:Default:TorrentRetryAttempts'] ?? 1,
                        downloadRetryAttempts: settings['Integrations:Default:DownloadRetryAttempts'] ?? 3,
                        deleteOnError       : settings['Integrations:Default:DeleteOnError'] ?? 0,
                        lifetime            : settings['Integrations:Default:TorrentLifetime'] ?? 0,
                        includeRegex        : includeRegex,
                    }

                    let nativeRes: Response
                    if (isMagnet) {
                        nativeRes = await clientFetch(config, `${config.url}/Api/Torrents/UploadMagnet`, {
                            method : 'POST',
                            headers: { ...authH, 'Content-Type': 'application/json' },
                            body   : JSON.stringify({ magnetLink: url, torrent: torrentPayload }),
                        })
                    } else if (torrentBytes) {
                        const form = new FormData()
                        form.append('file', new Blob([torrentBytes], { type: 'application/x-bittorrent' }), 'torrent.torrent')
                        form.append('formData', JSON.stringify({ torrent: torrentPayload }))
                        nativeRes = await clientFetch(config, `${config.url}/Api/Torrents/UploadFile`, {
                            method : 'POST',
                            body   : form,
                            headers: authH,
                        })
                    } else {
                        throw new Error('Données du torrent indisponibles')
                    }

                    if (nativeRes.ok) {
                        uploadSuccess = true
                        logger.info('rdtclient', `Torrent envoyé à RDT-Client avec sélection stricte de ${targetFileNames.length} fichier(s) (includeRegex)`)
                    } else {
                        const errTxt = await nativeRes.text().catch(() => '')
                        logger.debug('rdtclient', `API native RDT-Client HTTP ${nativeRes.status} (${errTxt}), repli sur qBittorrent add`)
                    }
                } catch (nativeErr) {
                    logger.debug('rdtclient', `Erreur API native RDT-Client : ${nativeErr instanceof Error ? nativeErr.message : nativeErr}`)
                }
            }

            // Tentative 2 (repli) : Émulation qBittorrent classique (/api/v2/torrents/add)
            if (!uploadSuccess) {
                let res: Response
                if (isMagnet) {
                    const params = new URLSearchParams()
                    params.set('urls', url)
                    if (config.category) params.set('category', String(config.category))
                    if (config.savePath)  params.set('savepath', String(config.savePath))
                    res = await clientFetch(config, `${config.url}/api/v2/torrents/add`, {
                        method : 'POST',
                        body   : params,
                        headers: { ...authH, 'Content-Type': 'application/x-www-form-urlencoded' },
                    })
                } else if (torrentBytes) {
                    const form = new FormData()
                    if (config.category) form.append('category', String(config.category))
                    if (config.savePath)  form.append('savepath', String(config.savePath))
                    form.append('torrents', new Blob([torrentBytes], { type: 'application/x-bittorrent' }), 'torrent.torrent')
                    res = await clientFetch(config, `${config.url}/api/v2/torrents/add`, { method: 'POST', body: form, headers: authH })
                } else {
                    throw new Error('Données du torrent indisponibles')
                }

                const text = await res.text()
                if (!isRdtAddSuccess(res, text)) {
                    throw new Error(`RDT-Client a refusé le torrent : ${text.trim() || `HTTP ${res.status}`}`)
                }
            }

            const indicesToPrioritize = Array.isArray(options?.file_indices) && options.file_indices.length > 0
                ? options.file_indices
                : (options?.file_index != null ? [options.file_index] : [])

            if (hash) {
                logger.info('rdtclient', `Torrent ajouté (${targetFileNames.length || indicesToPrioritize.length} fichier(s) configuré(s))`)
                for (const idx of indicesToPrioritize) {
                    rdtApplyFilePriority(config, hash, idx).catch(err =>
                        logger.warn('rdtclient', `Priorité de fichier non appliquée (n° ${idx}) : ${err instanceof Error ? err.message : err}`)
                    )
                }
            } else {
                logger.info('rdtclient', `Torrent ajouté sans hash connu : recherche dans la liste (${targetFileNames.length || indicesToPrioritize.length} fichier(s))`)
                ;(async () => {
                    for (let attempt = 0; attempt < 20; attempt++) {
                        await new Promise(r => setTimeout(r, 1000))
                        try {
                            const ah = await rdtAuth(config)
                            const lr = await clientFetch(config, `${config.url}/api/v2/torrents/info`, { headers: ah })
                            if (!lr.ok) continue
                            const list = await lr.json()
                            const newT = list.find((t: any) => !knownHashes.has(String(t.hash).toLowerCase()))
                            if (!newT) continue
                            const resolvedHash = String(newT.hash).toLowerCase()
                            logger.info('rdtclient', `Hash résolu : ${resolvedHash.slice(0, 8)}…, configuration des fichiers`)
                            for (const idx of indicesToPrioritize) {
                                await rdtApplyFilePriority(config, resolvedHash, idx)
                            }
                            return
                        } catch {}
                    }
                    logger.warn('rdtclient', `Hash introuvable : impossible de sélectionner les fichiers du torrent`)
                })().catch(() => {})
            }
            return
        }

        const params = new URLSearchParams()
        params.set('urls', url)
        if (config.category) params.set('category', String(config.category))
        if (config.savePath)  params.set('savepath', String(config.savePath))

        const res  = await clientFetch(config, `${config.url}/api/v2/torrents/add`, {
            method : 'POST',
            body   : params,
            headers: { ...authH, 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        const text = await res.text()
        if (!isRdtAddSuccess(res, text)) {
            throw new Error(`RDT-Client a refusé le torrent : ${text.trim() || `HTTP ${res.status}`}`)
        }
        logger.info('rdtclient', `Torrent ajouté (catégorie : ${config.category ?? 'aucune'}${config.savePath ? `, dossier : ${config.savePath}` : ''})`)
    },

    async remove(config, hash, deleteFiles = false) {
        const authH = await rdtAuth(config)
        const params = new URLSearchParams({ hashes: hash, deleteFiles: deleteFiles ? 'true' : 'false' })
        const res = await clientFetch(config, `${config.url}/api/v2/torrents/delete`, {
            method : 'POST',
            body   : params,
            headers: { ...authH, 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        if (!res.ok) throw new Error(`Échec de la suppression (HTTP ${res.status})`)
        logger.info('rdtclient', `Torrent ${hash.slice(0, 8)}… supprimé${deleteFiles ? ' (avec fichiers)' : ''}`)
    },
}

export default RDTClient
