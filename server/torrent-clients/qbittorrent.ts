/** qBittorrent 4.x et 5.x (clé API à partir de 5.2.0). */

import type { TorrentClientDriver, TorrentInfo, DownloadOptions, ClientConfig } from './index.js'
import { clientFetch, buildMultipart } from './index.js'
import { logger } from '../logger.js'

// Réponse « Ok. », HTTP 200 vide (RDT-Client / proxies), ou JSON de succès
function isQbAddSuccess(res: Response, text: string): boolean {
    const trimmed = text.trim()
    if (trimmed === 'Ok.') return true
    if (res.ok) {
        if (trimmed === 'Ok' || trimmed === '') return true
        try {
            const json = JSON.parse(text)
            if (typeof json?.success_count === 'number') return json.success_count > 0
            if (json?.success === true || json?.result === true || json?.status === 'success') return true
        } catch {}
        const lower = trimmed.toLowerCase()
        if (!lower.includes('fail') && !lower.includes('error')) return true
    }
    return false
}

function mapState(state: string, progress = 0): TorrentInfo['state'] {
    if ([
        'uploading', 'queuedUP', 'stalledUP', 'forcedUP',
        'finished', 'completed',
        'pausedUP', 'stoppedUP',
    ].includes(state)) {
        return 'seeding'
    }
    if (progress >= 1) return 'seeding'
    if (['downloading', 'metaDL', 'queuedDL', 'stalledDL', 'forcedDL'].includes(state)) return 'downloading'
    if (['checkingDL', 'checkingUP', 'checkingResumeData'].includes(state)) return 'checking'
    if (state === 'error' || state === 'missingFiles') return 'error'
    if (['pausedDL', 'stoppedDL'].includes(state)) return 'paused'
    return 'unknown'
}

async function qbAuth(config: ClientConfig): Promise<Record<string, string>> {
    if (config.apiKey) {
        return { Authorization: `Bearer ${config.apiKey}` }
    }
    const cookie = await qbLogin(config)
    return { Cookie: cookie }
}

async function qbLogin(config: ClientConfig): Promise<string> {
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
    if (!cookie) throw new Error('Cookie de session introuvable')
    return cookie
}

async function qbTorrentExists(config: ClientConfig, authHeaders: Record<string, string>, hash: string): Promise<boolean> {
    try {
        const res = await clientFetch(config, `${config.url}/api/v2/torrents/info?hashes=${hash}`, {
            headers: authHeaders,
        })
        if (!res.ok) return false
        const list = await res.json()
        return Array.isArray(list) && list.length > 0
    } catch {
        return false
    }
}

async function qbApplyFilePriorities(
    config     : ClientConfig,
    hash       : string,
    fileIndices: number[],
): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(r => setTimeout(r, attempt === 0 ? 100 : 500))
        try {
            const authH = await qbAuth(config)
            const res = await clientFetch(config, `${config.url}/api/v2/torrents/files?hash=${hash}`, {
                headers: authH,
            })
            if (!res.ok) continue
            const files: any[] = await res.json()
            if (!Array.isArray(files) || files.length === 0) continue

            const validIndices = fileIndices.filter(i => i < files.length)
            if (validIndices.length === 0) {
                logger.warn('qbittorrent', `Indices demandés hors limites : le torrent contient ${files.length} fichiers`)
                return
            }

            // Premier épisode choisi : tout désactiver sauf les cibles ; sinon activer seulement les cibles
            const isInitialState = files.every((f: any) => (f.priority ?? 1) > 0)
            const headers = { ...authH, 'Content-Type': 'application/x-www-form-urlencoded' }

            if (isInitialState) {
                const unwanted = files.map((_, i) => i).filter(i => !validIndices.includes(i))
                if (unwanted.length > 0) {
                    const body = new URLSearchParams({ hash, id: unwanted.join('|'), priority: '0' })
                    const r = await clientFetch(config, `${config.url}/api/v2/torrents/filePrio`, { method: 'POST', body, headers })
                    if (!r.ok) { logger.warn('qbittorrent', `Priorités non appliquées (HTTP ${r.status}), nouvel essai`); continue }
                }
            }

            const r2 = await clientFetch(config, `${config.url}/api/v2/torrents/filePrio`, {
                method: 'POST',
                body  : new URLSearchParams({ hash, id: validIndices.join('|'), priority: '1' }),
                headers,
            })
            if (!r2.ok) { logger.warn('qbittorrent', `Priorité des fichiers cibles non appliquée (HTTP ${r2.status}), nouvel essai`); continue }

            logger.info('qbittorrent', `${validIndices.length} fichier(s) sélectionné(s) pour ${hash.slice(0, 8)}…`)
            return
        } catch (err) {
            if (err instanceof Error && err.message.includes('hors limites')) throw err
        }
    }

    logger.warn('qbittorrent', `Métadonnées des fichiers du torrent ${hash.slice(0, 8)}… non configurées (le téléchargement global continue)`)
}

async function qbApplyFilePriority(
    config   : ClientConfig,
    hash     : string,
    fileIndex: number,
): Promise<void> {
    return qbApplyFilePriorities(config, hash, [fileIndex])
}

const QB: TorrentClientDriver = {
    definition: {
        id    : 'qbittorrent',
        label : 'qBittorrent',
        fields: [
            { key: 'url',      label: 'URL de la WebUI',  type: 'url',      placeholder: 'http://localhost:8080', required: true },
            { key: 'apiKey',   label: 'Clé API (qBittorrent 5.2 ou plus)', type: 'password', placeholder: 'qbt_xxxx…', required: false },
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
            const authH = await qbAuth(config)
            const res = await clientFetch(config, `${config.url}/api/v2/app/version`, { headers: authH })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            logger.info('qbittorrent', `Test de connexion réussi sur ${config.url}`)
            return { ok: true, message: 'Connexion réussie' }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Erreur inattendue, consultez les journaux'
            logger.warn('qbittorrent', `Échec du test de connexion sur ${config.url} : ${msg}`)
            return { ok: false, message: msg }
        }
    },

    async healthcheck(config) {
        try {
            const authH = await qbAuth(config)
            const res = await clientFetch(config, `${config.url}/api/v2/app/version`, {
                headers: authH,
            })
            if (!res.ok) return { online: false }
            const version = (await res.text()).trim()
            if (version.startsWith('<')) throw new Error('Réponse HTML reçue : clé API invalide ou non prise en charge par cette version de qBittorrent')
            logger.debug('qbittorrent', `Client en ligne (version ${version})`)
            return { online: true, version }
        } catch (err) {
            logger.debug('qbittorrent', `Client injoignable : ${err instanceof Error ? err.message : err}`)
            return { online: false }
        }
    },

    async list(config, category) {
        const authH  = await qbAuth(config)
        const params = new URLSearchParams()
        if (category) params.set('category', category)
        const res = await clientFetch(config, `${config.url}/api/v2/torrents/info?${params}`, {
            headers: authH,
        })
        if (!res.ok) throw new Error(`Liste des torrents inaccessible (HTTP ${res.status})`)
        const data: any[] = await res.json()

        const fileMap = new Map<string, any[]>()
        await Promise.all(data.map(async (t: any) => {
            try {
                const r = await clientFetch(config, `${config.url}/api/v2/torrents/files?hash=${t.hash}`, {
                    headers: authH,
                })
                if (r.ok) fileMap.set(t.hash, await r.json())
            } catch {}
        }))

        return data.map(t => {
            const fileInfo = fileMap.get(t.hash) ?? []
            return {
                hash      : t.hash,
                name      : t.name,
                state     : mapState(t.state, t.progress),
                progress  : Math.round(t.progress * 100),
                size      : t.size,
                downloaded: t.downloaded,
                uploaded  : t.uploaded ?? 0,
                ratio     : Math.round((t.ratio ?? 0) * 100) / 100,
                speed     : t.dlspeed,
                upspeed   : t.upspeed ?? 0,
                eta       : t.eta ?? -1,
                save_path : t.save_path,
                category  : t.category ?? '',
                files     : fileInfo.length > 0
                    ? fileInfo.map((f: any, i: number) => ({
                        index   : i,
                        name    : String(f.name ?? ''),
                        progress: f.progress ?? 0,   // 0–1
                        priority: f.priority ?? 1,
                        size    : Number(f.size ?? 0),
                    }))
                    : undefined,
            } satisfies TorrentInfo
        })
    },

    async getFiles(config, hash) {
        const authH = await qbAuth(config)
        const res = await clientFetch(config, `${config.url}/api/v2/torrents/files?hash=${hash}`, {
            headers: authH,
        })
        if (!res.ok) return []
        const data: any[] = await res.json()
        return data.map((f: any, i: number) => ({
            index   : i,
            name    : String(f.name ?? ''),
            progress: f.progress ?? 0,
            priority: f.priority ?? 1,
            size    : Number(f.size ?? 0),
        }))
    },

    async add(config, url, options?: DownloadOptions) {
        const authH = await qbAuth(config)

        const hash = (options?.infohash?.toLowerCase() ?? null)
                  || url.match(/xt=urn:btih:([a-fA-F0-9]{40,})/i)?.[1]?.toLowerCase()
                  || options?.magnet?.match(/xt=urn:btih:([a-fA-F0-9]{40,})/i)?.[1]?.toLowerCase()
                  || null

        const targetIndices: number[] = Array.isArray(options?.file_indices) && options.file_indices.length > 0
            ? options.file_indices
            : (options?.file_index != null ? [options.file_index] : [])

        const hasFileFilter = targetIndices.length > 0

        if (hasFileFilter) {
            if (hash) {
                const exists = await qbTorrentExists(config, authH, hash)
                if (exists) {
                    logger.info('qbittorrent', `Torrent ${hash.slice(0, 8)}… déjà présent, sélection de ${targetIndices.length} fichier(s)`)
                    qbApplyFilePriorities(config, hash, targetIndices).catch(err =>
                        logger.warn('qbittorrent', `Priorité de fichier non appliquée : ${err instanceof Error ? err.message : err}`)
                    )
                    return
                }
            }

            // Hashes présents avant l'ajout, pour repérer le nouveau torrent si le hash est inconnu
            let knownHashes: Set<string> = new Set()
            if (!hash) {
                try {
                    const lr = await clientFetch(config, `${config.url}/api/v2/torrents/info`, { headers: authH })
                    if (lr.ok) knownHashes = new Set((await lr.json()).map((t: any) => String(t.hash).toLowerCase()))
                } catch {}
            }

            // Envoi prioritaire via l'URL (application/x-www-form-urlencoded) :
            // Supporté nativement par qBittorrent et RDT-Client (évite les erreurs de flux multipart ASP.NET Core)
            const params = new URLSearchParams()
            params.set('urls', url)
            if (config.category) params.set('category', String(config.category))
            if (config.savePath)  params.set('savepath', String(config.savePath))

            let res = await clientFetch(config, `${config.url}/api/v2/torrents/add`, {
                method : 'POST',
                body   : params,
                headers: { ...authH, 'Content-Type': 'application/x-www-form-urlencoded' },
            })
            let text = await res.text()

            // Repli multipart uniquement si urls a échoué et que l'URL est un fichier .torrent HTTP
            if (!isQbAddSuccess(res, text) && !url.startsWith('magnet:')) {
                try {
                    logger.debug('qbittorrent', `Tentative de repli par upload du fichier .torrent : ${url.slice(0, 120)}`)
                    const torrentRes = await fetch(url, { headers: { 'User-Agent': 'FanKarr/1.0' } })
                    if (torrentRes.ok) {
                        const torrentBytes = await torrentRes.arrayBuffer()
                        const fields: Record<string, string> = {}
                        if (config.category) fields.category = String(config.category)
                        if (config.savePath)  fields.savepath = String(config.savePath)
                        const mp = buildMultipart(fields, {
                            name: 'torrents',
                            filename: 'torrent.torrent',
                            data: torrentBytes,
                            contentType: 'application/x-bittorrent',
                        })
                        const fbRes = await clientFetch(config, `${config.url}/api/v2/torrents/add`, {
                            method : 'POST',
                            body   : mp.body as any,
                            headers: { ...authH, 'Content-Type': mp.contentType, 'Content-Length': String(mp.body.length) },
                        })
                        const fbText = await fbRes.text()
                        if (isQbAddSuccess(fbRes, fbText)) {
                            res  = fbRes
                            text = fbText
                        }
                    }
                } catch (fbErr) {
                    logger.debug('qbittorrent', `Échec du repli upload .torrent : ${fbErr instanceof Error ? fbErr.message : fbErr}`)
                }
            }
            if (!isQbAddSuccess(res, text)) throw new Error(`qBittorrent a refusé le torrent : ${text.trim() || `HTTP ${res.status}`}`)

            if (hash) {
                logger.info('qbittorrent', `Torrent ajouté, sélection de ${targetIndices.length} fichier(s) dès réception des métadonnées`)
                qbApplyFilePriorities(config, hash, targetIndices).catch(err =>
                    logger.warn('qbittorrent', `Priorité de fichier non appliquée : ${err instanceof Error ? err.message : err}`)
                )
            } else {
                logger.info('qbittorrent', `Torrent ajouté sans hash connu : recherche dans la liste (${targetIndices.length} fichier(s))`)
                ;(async () => {
                    for (let attempt = 0; attempt < 20; attempt++) {
                        await new Promise(r => setTimeout(r, 500))
                        try {
                            const ah = await qbAuth(config)
                            const lr = await clientFetch(config, `${config.url}/api/v2/torrents/info`, { headers: ah })
                            if (!lr.ok) continue
                            const newT = (await lr.json()).find((t: any) => !knownHashes.has(String(t.hash).toLowerCase()))
                            if (!newT) continue
                            const resolvedHash = String(newT.hash).toLowerCase()
                            logger.info('qbittorrent', `Hash résolu : ${resolvedHash.slice(0, 8)}…, sélection des fichiers`)
                            await qbApplyFilePriorities(config, resolvedHash, targetIndices)
                            return
                        } catch {}
                    }
                    logger.warn('qbittorrent', `Hash introuvable : impossible de sélectionner les fichiers demandés`)
                })().catch(() => {})
            }
            return
        }

        // Pas de filtre de fichier (téléchargement intégral)
        const params = new URLSearchParams()
        params.set('urls', url)
        if (config.category) params.set('category', String(config.category))
        if (config.savePath)  params.set('savepath', String(config.savePath))

        let res = await clientFetch(config, `${config.url}/api/v2/torrents/add`, {
            method : 'POST',
            body   : params,
            headers: { ...authH, 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        let text = await res.text()

        // Repli multipart si refusé sur URL HTTP
        if (!isQbAddSuccess(res, text) && !url.startsWith('magnet:')) {
            try {
                logger.debug('qbittorrent', `Tentative de repli par upload du fichier .torrent : ${url.slice(0, 120)}`)
                const torrentRes = await fetch(url, { headers: { 'User-Agent': 'FanKarr/1.0' } })
                if (torrentRes.ok) {
                    const torrentBytes = await torrentRes.arrayBuffer()
                    const fields: Record<string, string> = {}
                    if (config.category) fields.category = String(config.category)
                    if (config.savePath)  fields.savepath = String(config.savePath)
                    const mp = buildMultipart(fields, {
                        name: 'torrents',
                        filename: 'torrent.torrent',
                        data: torrentBytes,
                        contentType: 'application/x-bittorrent',
                    })
                    const fbRes = await clientFetch(config, `${config.url}/api/v2/torrents/add`, {
                        method : 'POST',
                        body   : mp.body as any,
                        headers: { ...authH, 'Content-Type': mp.contentType, 'Content-Length': String(mp.body.length) },
                    })
                    const fbText = await fbRes.text()
                    if (isQbAddSuccess(fbRes, fbText)) {
                        res  = fbRes
                        text = fbText
                    }
                }
            } catch (fbErr) {
                logger.debug('qbittorrent', `Échec du repli upload .torrent : ${fbErr instanceof Error ? fbErr.message : fbErr}`)
            }
        }
        if (!isQbAddSuccess(res, text)) throw new Error(`qBittorrent a refusé le torrent : ${text.trim() || `HTTP ${res.status}`}`)
        logger.info('qbittorrent', `Torrent ajouté (catégorie : ${config.category ?? 'aucune'}${config.savePath ? `, dossier : ${config.savePath}` : ''})`)
    },

    async remove(config, hash, deleteFiles = false) {
        const authH = await qbAuth(config)
        const sendDelete = async (h: string) => {
            const params = new URLSearchParams({ hashes: h, deleteFiles: deleteFiles ? 'true' : 'false' })
            return clientFetch(config, `${config.url}/api/v2/torrents/delete`, {
                method : 'POST',
                body   : params,
                headers: { ...authH, 'Content-Type': 'application/x-www-form-urlencoded' },
            })
        }
        let res = await sendDelete(hash)
        if (!res.ok && hash.toLowerCase() !== hash) {
            res = await sendDelete(hash.toLowerCase())
        }
        if (!res.ok && hash.toUpperCase() !== hash) {
            res = await sendDelete(hash.toUpperCase())
        }
        if (!res.ok) throw new Error(`Échec de la suppression (HTTP ${res.status})`)
        logger.info('qbittorrent', `Torrent ${hash.slice(0, 8)}… supprimé${deleteFiles ? ' (avec fichiers)' : ''}`)
    },
}

export default QB
