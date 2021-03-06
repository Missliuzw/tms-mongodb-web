const base = (process.env.VUE_APP_BACK_API_BASE || '') + '/mongo/schema'

export default function create(tmsAxios) {
  return {
    list(bucket, type) {
      const params = { bucket, scope: type }
      return tmsAxios
        .get(`${base}/list`, { params })
        .then(rst => rst.data.result)
    },
    listByTag(bucket, tagName) {
      const params = { bucket, tag: tagName }
      return tmsAxios
        .get(`${base}/listByTag`, { params })
        .then(rst => rst.data.result)
    }
  }
}
