import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import { requireAuth } from '../auth.js'
import { logger } from '../logger.js'
import { DATA_DIR } from '../config.js'
import { readSettings } from '../settings.js'
import { dispatchDownload, dispatchList, dispatchRemove } from '../torrent-clients/index.js'
import { readAvailable, readInfohashMap, readSerieData } from '../lib/github-cache.js'
import { extractTorrentsFromSerieData, buildResolvedEpisodes } from '../lib/serie-helpers.js'
import { recentOrganized } from '../lib/notifs.js'

const router = Router()

router.post('/download', requireAuth, async (req, res) => {
    // Préférer le fichier .torrent au magnet : métadonnées immédiates, pas de dépendance DHT/trackers
    const torrent_url: string | null = req.body.torrent_url ?? null
    const magnet     : string | null = req.body.magnet      ?? null
    const url = torrent_url ?? magnet
    if (!url) { res.status(400).json({ error: 'Lien du torrent ou magnet requis' }); return }
    const file_index  : number | null   = req.body.file_index != null ? Number(req.body.file_index) : null
    const file_path   : string | null   = req.body.file_path  ?? null
    const file_indices: number[] | null = Array.isArray(req.body.file_indices)
        ? req.body.file_indices.map(Number)
        : (file_index != null ? [file_index] : null)
    const file_paths  : string[] | null = Array.isArray(req.body.file_paths)
        ? req.body.file_paths.map(String)
        : (file_path ? [file_path] : null)
    const infohash    : string | null   = req.body.infohash   ?? null
    const label = file_paths?.length
        ? ` (${file_paths.length > 1 ? `${file_paths.length} fichiers` : file_paths[0]})`
        : ''
    logger.info('api', `Téléchargement demandé via ${torrent_url ? '.torrent' : 'magnet'}${label}`)
    const results = await dispatchDownload(url, { file_index, file_path, file_indices, file_paths, infohash, magnet })
    res.status(results.every((r: any) => r.ok) ? 200 : 207).json({ results })
})

router.delete('/torrent/:hash', requireAuth, async (req, res) => {
    const hash        = String(req.params.hash)
    const deleteFiles = req.query.deleteFiles === 'true'
    const altHash     = req.query.altHash ? String(req.query.altHash) : undefined
    if (!hash) { res.status(400).json({ error: 'Hash du torrent requis' }); return }
    try {
        const result = await dispatchRemove(hash, deleteFiles, altHash)
        res.json(result)
    } catch (err) {
        logger.error('api', `Échec de la suppression du torrent : ${err instanceof Error ? err.message : err}`)
        res.status(500).json({ error: err instanceof Error ? err.message : 'Erreur inattendue, consultez les journaux' })
    }
})

router.get('/downloads', requireAuth, async (_req, res) => {
    try {
        const { category } = readSettings()
        const infohashMap = await readInfohashMap()
        const torrents = await dispatchList(category ?? 'fankai', infohashMap)
        let organized: Record<string, Record<string, any>> = {}
        try { const p = path.join(DATA_DIR, 'organized.json'); if (fs.existsSync(p)) organized = JSON.parse(fs.readFileSync(p, 'utf-8')) } catch {}
        const enriched = await Promise.all(torrents.map(async (t: any) => {
            let totalFiles = 1
            let serieName: string | undefined
            let serieId: number | undefined
            let episodes: any[] = []
            let matchedInfohash: string | undefined
            try {
                const availableIds = await readAvailable()
                for (const id of availableIds) {
                    const sd = await readSerieData(id)
                    if (!sd) continue
                    const match = extractTorrentsFromSerieData(sd).find((st: any) =>
                        (st.infohash && t.hash && st.infohash.toLowerCase() === t.hash.toLowerCase()) ||
                        (t.name && st.title && st.title.toLowerCase().trim() === t.name.toLowerCase().trim())
                    )
                    if (match) {
                        const resolved = buildResolvedEpisodes(sd, match.infohash, match.season_number)
                        totalFiles = resolved.length || 1
                        serieName  = sd.title ?? sd.show_title
                        serieId    = sd.id
                        episodes   = resolved
                        matchedInfohash = match.infohash
                        break
                    }
                }
            } catch {}

            const hashCandidates = [
                t.hash,
                t.hash?.toLowerCase(),
                t.hash?.toUpperCase(),
                matchedInfohash,
                matchedInfohash?.toLowerCase(),
            ].filter(Boolean) as string[]

            let orgFiles: Record<string, any> = {}
            for (const hc of hashCandidates) {
                if (organized[hc]) {
                    orgFiles = organized[hc]
                    break
                }
            }

            const doneFiles = Object.keys(orgFiles).length
            const organizeState: 'none' | 'partial' | 'done' = doneFiles >= totalFiles ? 'done' : doneFiles > 0 ? 'partial' : 'none'
            const notif    = recentOrganized.find(n => hashCandidates.includes(n.hash))
            const imported = recentOrganized.find(n => hashCandidates.includes(n.hash) && n.done > 0)
            return { ...t, organizeState, organizeProgress: { done: doneFiles, total: totalFiles }, errorFiles: notif?.errorFiles ?? [], importedAt: imported?.at ?? null, serieId, serieName, episodes }
        }))
        res.json(enriched)
    } catch (err) {
        logger.error('api', `Échec du chargement des téléchargements : ${err instanceof Error ? err.message : err}`)
        res.status(500).json({ error: err instanceof Error ? err.message : 'Erreur inattendue, consultez les journaux' })
    }
})

export default router
