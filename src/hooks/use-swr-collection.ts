import useSWR, { mutate as mutateStatic, SWRConfiguration } from 'swr'
import { fuego } from '../context/Provider'
import { useRef, useEffect, useMemo, useCallback } from 'react'
import { empty } from '../helpers/empty'
import { collectionCache } from '../classes/Cache'

import type {
  DocumentData,
  FieldPath,
  OrderByDirection,
  WhereFilterOp,
  Query,
  Unsubscribe,
  QueryConstraint,
} from '@firebase/firestore'
import {
  query,
  getDocs as _getDocs,
  onSnapshot,
  collection,
  collectionGroup,
  orderBy as _orderBy,
  where as _where,
  startAt as _startAt,
  startAfter as _startAfter,
  endBefore as _endBefore,
  endAt as _endAt,
  limit as _limit,
  doc as _doc,
  writeBatch,
} from '@firebase/firestore'
import { isDev } from '../helpers/is-dev'
import { withDocumentDatesParsed } from '../helpers/doc-date-parser'
import { Document } from '../types'

type KeyHack = string & DocumentData // hack to also allow strings

// here we get the "key" from our data, to add intellisense for any "orderBy" in the queries and such.
type OrderByArray<Doc extends DocumentData, Key = keyof Doc> = [
  Key | FieldPath | KeyHack,
  OrderByDirection
]
type OrderByItem<Doc extends DocumentData, Key = keyof Doc> =
  | OrderByArray<Doc>
  | Key
  | KeyHack
type OrderByType<Doc extends DocumentData> =
  | OrderByItem<Doc>
  | OrderByArray<Doc>[]

type WhereItem<Doc extends DocumentData, Key = keyof Doc> = [
  Key | FieldPath | KeyHack,
  WhereFilterOp,
  unknown
]
type WhereArray<Doc extends DocumentData> = WhereItem<Doc>[]
type WhereType<Doc extends DocumentData> = WhereItem<Doc> | WhereArray<Doc>

export type CollectionQueryType<Doc extends DocumentData> = {
  limit?: number
  orderBy?: OrderByType<Doc>
  where?: WhereType<Doc>
  isCollectionGroup?: boolean
  startAt?: number
  endAt?: number
  startAfter?: number
  endBefore?: number
}

export const getDocs = async <
  Data extends DocumentData,
  Doc extends Document = Document<Data>
>(
  path: string,
  // queryString: string = '{}',
  query: CollectionQueryType<Doc> = {},
  {
    parseDates,
    ignoreFirestoreDocumentSnapshotField,
  }: {
    parseDates?: (string | keyof Doc)[]
    /**
     * If `true`, docs returned in `data` will not include the firestore `__snapshot` field. If `false`, it will include a `__snapshot` field. This lets you access the document snapshot, but makes the document not JSON serializable.
     *
     * Default: `false`
     */
    ignoreFirestoreDocumentSnapshotField?: boolean
  } = empty.object
) => {
  const ref = createFirestoreRef(path, query)
  const data: Doc[] = await _getDocs(ref).then((querySnapshot) => {
    const array: typeof data = []
    querySnapshot.forEach((doc) => {
      const docData =
        doc.data({
          serverTimestamps: 'estimate',
        }) ?? empty.object
      const docToAdd = withDocumentDatesParsed(
        {
          ...docData,
          id: doc.id,
          exists: doc.exists(),
          hasPendingWrites: doc.metadata.hasPendingWrites,
          __snapshot: ignoreFirestoreDocumentSnapshotField ? undefined : doc,
        } as any,
        parseDates
      )
      // update individual docs in the cache
      mutateStatic(doc.ref.path, docToAdd, false)
      if (isDev && (docData.exists || docData.id || docData.hasPendingWrites)) {
        console.warn(
          '[get-collection] warning: Your document, ',
          doc.id,
          ' is using one of the following reserved fields: [exists, id, hasPendingWrites]. These fields are reserved. Please remove them from your documents.'
        )
      }
      array.push(docToAdd)
    })
    return array
  })
  return data
}

const createFirestoreRef = <Doc extends DocumentData>(
  path: string,
  {
    where,
    orderBy,
    limit,
    startAt,
    endAt,
    startAfter,
    endBefore,
    isCollectionGroup,
  }: CollectionQueryType<Doc>
) => {
  let ref: Query = collection(fuego.db, path)
  const queries: QueryConstraint[] = []
  if (isCollectionGroup) {
    ref = collectionGroup(fuego.db, path)
  }

  if (where) {
    const multipleConditions = (w: WhereType<Doc>): w is WhereArray<Doc> => {
      return !!(w as WhereArray<Doc>) && Array.isArray(w[0])
    }
    ;(multipleConditions(where) ? where : [where]).forEach((w) =>
      queries.push(_where(w[0] as string, w[1], w[2]))
    )
  }

  if (orderBy) {
    if (typeof orderBy === 'string') {
      queries.push(_orderBy(orderBy))
    } else if (Array.isArray(orderBy)) {
      const multipleOrderBy = (
        o: OrderByType<Doc>
      ): o is OrderByArray<Doc>[] => {
        return Array.isArray((o as OrderByArray<Doc>[])[0])
      }
      ;(multipleOrderBy(orderBy) ? orderBy : [orderBy]).forEach(
        ([order, direction]) =>
          queries.push(_orderBy(order as string | FieldPath, direction))
      )
    }
  }

  if (startAt) {
    queries.push(_startAt(startAt))
  }

  if (endAt) {
    queries.push(_endAt(endAt))
  }

  if (startAfter) {
    queries.push(_startAfter(startAfter))
  }

  if (endBefore) {
    queries.push(_endBefore(endBefore))
  }

  if (limit) {
    queries.push(_limit(limit))
  }

  return queries.length > 0 ? query(ref, ...queries) : ref
}

type ListenerReturnType<Doc extends Document = Document> = {
  initialData: Doc[] | null
  unsubscribe: Unsubscribe
}

const createListenerAsync = async <Doc extends Document = Document>(
  path: string,
  queryString: string,
  {
    parseDates,
    ignoreFirestoreDocumentSnapshotField = true,
  }: // isCollectionGroup = false,
  {
    parseDates?: (string | keyof Doc)[]
    /**
     * If `true`, docs returned in `data` will not include the firestore `__snapshot` field. If `false`, it will include a `__snapshot` field. This lets you access the document snapshot, but makes the document not JSON serializable.
     *
     * Default: `true`
     */
    ignoreFirestoreDocumentSnapshotField?: boolean
  }
): Promise<ListenerReturnType<Doc>> => {
  return new Promise((resolve) => {
    const query: CollectionQueryType<Doc> = JSON.parse(queryString) ?? {}
    const ref = createFirestoreRef(path, query)
    const unsubscribe = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (querySnapshot) => {
        const data: Doc[] = []
        querySnapshot.forEach((doc) => {
          const docData =
            doc.data({
              serverTimestamps: 'estimate',
            }) ?? empty.object
          const docToAdd = withDocumentDatesParsed(
            {
              ...docData,
              id: doc.id,
              exists: doc.exists(),
              hasPendingWrites: doc.metadata.hasPendingWrites,
              __snapshot: ignoreFirestoreDocumentSnapshotField
                ? undefined
                : doc,
            } as any,
            parseDates
          )
          if (
            isDev &&
            (docData.exists || docData.id || docData.hasPendingWrites)
          ) {
            console.warn(
              '[use-collection] warning: Your document, ',
              doc.id,
              ' is using one of the following reserved fields: [exists, id, hasPendingWrites]. These fields are reserved. Please remove them from your documents.'
            )
          }
          // update individual docs in the cache
          mutateStatic(doc.ref.path, docToAdd, false)
          data.push(docToAdd)
        })
        // resolve initial data
        resolve({
          initialData: data,
          unsubscribe,
        })
        // update on listener fire
        mutateStatic([path, queryString], data, false)
      }
    )
  })
}

export type CollectionSWROptions<Doc extends Document = Document> =
  SWRConfiguration<Doc[] | null>
/**
 * Call a Firestore Collection
 * @template Doc
 * @param path String if the document is ready. If it's not ready yet, pass `null`, and the request won't start yet.
 * @param [query] - Dictionary with options to query the collection *AND* optionally accepts `listen`, `parseDates`, and `ignoreFirestoreDocumentSnapshotField` as well.
 * @param [options] - Dictionary of options to pass to the underlying useSWR library.
 */
export const useCollection = <
  Data extends DocumentData,
  Doc extends Document = Document<Data>
>(
  path: string | null,
  query: CollectionQueryType<Data> & {
    /**
     * If `true`, sets up a real-time subscription to the Firestore backend.
     *
     * Default: `false`
     */
    listen?: boolean
    /**
     * An array of key strings that indicate where there will be dates in the document.
     *
     * Example: if your dates are in the `lastUpdated` and `user.createdAt` fields, then pass `{parseDates: ["lastUpdated", "user.createdAt"]}`.
     *
     * This will automatically turn all Firestore dates into JS Date objects, removing the need to do `.toDate()` on your dates.
     */
    parseDates?: (string | keyof Doc)[]
    /**
     * If `true`, docs returned in `data` will not include the firestore `__snapshot` field. If `false`, it will include a `__snapshot` field. This lets you access the document snapshot, but makes the document not JSON serializable.
     *
     * Default: `true`
     */
    ignoreFirestoreDocumentSnapshotField?: boolean
  } = empty.object,
  options: CollectionSWROptions<Doc> = empty.object
) => {
  const unsubscribeRef = useRef<ListenerReturnType['unsubscribe'] | null>(null)

  const {
    where,
    endAt,
    endBefore,
    startAfter,
    startAt,
    orderBy,
    limit,
    listen = false,
    parseDates,
    // __unstableCollectionGroup: isCollectionGroup = false,
    isCollectionGroup,
    ignoreFirestoreDocumentSnapshotField = true,
  } = query

  // if we're listening, the firestore listener handles all revalidation
  const {
    refreshInterval = listen ? 0 : undefined,
    refreshWhenHidden = listen ? false : undefined,
    refreshWhenOffline = listen ? false : undefined,
    revalidateOnFocus = listen ? false : undefined,
    revalidateOnReconnect = listen ? false : undefined,
    dedupingInterval = listen ? 0 : undefined,
  } = options

  const swrOptions = {
    ...options,
    refreshInterval,
    refreshWhenHidden,
    refreshWhenOffline,
    revalidateOnFocus,
    revalidateOnReconnect,
    dedupingInterval,
  }

  // why not just put this into the ref directly?
  // so that we can use the useEffect down below that triggers revalidate()
  const memoQueryString = useMemo(
    () =>
      JSON.stringify({
        where,
        endAt,
        endBefore,
        startAfter,
        startAt,
        orderBy,
        limit,
        isCollectionGroup,
      }),
    [
      endAt,
      endBefore,
      isCollectionGroup,
      limit,
      orderBy,
      startAfter,
      startAt,
      where,
    ]
  )

  // we move this to a Ref
  // why? because we shouldn't have to include it in the key
  // if we do, then calling mutate() won't be consistent for all
  // collections with the same path & query
  // TODO figure out if this is the right behavior...probably not because of the paths. hm.
  // TODO it's not, move this to the
  // const isCollectionGroupQuery = useRef(isCollectionGroup)
  // useEffect(() => {
  //   isCollectionGroupQuery.current = isCollectionGroup
  // }, [isCollectionGroup])

  const dateParser = useRef(parseDates)
  useEffect(() => {
    dateParser.current = parseDates
  }, [parseDates])

  // we move listen to a Ref
  // why? because we shouldn't have to include "listen" in the key
  // if we do, then calling mutate() won't be consistent for all
  // collections with the same path & query
  const shouldListen = useRef(listen)
  useEffect(() => {
    shouldListen.current = listen
  })

  const shouldIgnoreSnapshot = useRef(ignoreFirestoreDocumentSnapshotField)
  useEffect(() => {
    shouldIgnoreSnapshot.current = ignoreFirestoreDocumentSnapshotField
  }, [ignoreFirestoreDocumentSnapshotField])

  const swr = useSWR<Doc[] | null>(
    // if the path is null, this means we don't want to fetch yet.
    path === null ? null : [path, memoQueryString],
    async (path: string, queryString: string) => {
      if (shouldListen.current) {
        if (unsubscribeRef.current) {
          unsubscribeRef.current()
          unsubscribeRef.current = null
        }
        const { unsubscribe, initialData } = await createListenerAsync<Doc>(
          path,
          queryString,
          {
            parseDates: dateParser.current,
            ignoreFirestoreDocumentSnapshotField: shouldIgnoreSnapshot.current,
          }
        )
        unsubscribeRef.current = unsubscribe
        return initialData
      }

      const data = await getDocs<Doc>(
        path,
        JSON.parse(queryString) as CollectionQueryType<Doc>,
        {
          parseDates: dateParser.current,
          ignoreFirestoreDocumentSnapshotField: shouldIgnoreSnapshot.current,
        }
      )
      return data
    },
    swrOptions
  )

  // if listen or changes,
  // we run revalidate.
  // This triggers SWR to fetch again
  // Why? because we don't want to put listen
  // in the useSWR key. If we did, then we couldn't mutate
  // based on query alone. If we had useSWR(['users', true]),
  // but then a `users` fetch with `listen` set to `false` updated, it wouldn't mutate both.
  // thus, we move the `listen` and option to a ref user in `useSWR`,
  // and we call `revalidate` if it changes.
  const mounted = useRef(false)
  useEffect(() => {
    // TODO should this only happen if listen is false? No, BC swr should revalidate on a change.
    if (mounted.current) revalidateRef.current()
    else mounted.current = true
  }, [listen])

  // this MUST be after the previous effect to avoid duplicate initial validations.
  // only happens on updates, not initial mounting
  const revalidateRef = useRef(swr.mutate)
  useEffect(() => {
    revalidateRef.current = swr.mutate
  })

  useEffect(() => {
    // TODO should this only be for listen, since SWR updates with the others?
    // also should it go before the useSWR?
    return () => {
      // clean up listener on unmount if it exists
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
    // should depend on the path, queyr, and listen being the same...
  }, [path, listen, memoQueryString])

  // add the collection to the cache,
  // so that we can mutate it from document calls later
  useEffect(() => {
    if (path) collectionCache.addCollectionToCache(path, memoQueryString)
  }, [path, memoQueryString])

  const { data, isValidating, mutate, error } = swr

  /**
   * `add(data)`: Extends the Firestore document [`add` function](https://firebase.google.com/docs/firestore/manage-data/add-data).
   * - It also updates the local cache using SWR's `mutate`. This will prove highly convenient over the regular `add` function provided by Firestore.
   */
  const add = useCallback(
    <T extends Data | Data[]>(
      data: T
    ): Promise<T extends Data ? string : string[]> | null => {
      if (!path) return null

      const multiple = Array.isArray(data)
      const dataArray = multiple ? (data as T[]) : [data]

      const ref = collection(fuego.db, path)

      const docsToAdd: Doc[] = dataArray.map((doc) => ({
        ...doc,
        // generate IDs we can use that in the local cache that match the server
        id: _doc(ref).id,
      })) as unknown as Doc[] // solve this annoying TS bug 😅

      // add to cache
      if (!listen) {
        // we only update the local cache if we don't have a listener set up
        // why? because Firestore automatically handles this part for subscriptions
        mutate((prevState) => {
          const state = prevState ?? empty.array
          return [...state, ...docsToAdd]
        }, false)
      }

      // add to network
      const batch = writeBatch(fuego.db)

      docsToAdd.forEach(({ id, ...doc }) => {
        // take the ID out of the document
        batch.set(_doc(ref, id), doc)
      })

      return batch.commit().then(() => {
        const ids = docsToAdd.map(({ id }) => id)
        const returnValue = multiple ? ids : ids[0]

        return returnValue as T extends Data ? string : string[]
      })
    },
    [listen, mutate, path]
  )

  return {
    data,
    isValidating,
    mutate,
    error,
    add,
    loading: !data && !error,
    /**
     * A function that, when called, unsubscribes the Firestore listener.
     *
     * The function can be null, so make sure to check that it exists before calling it.
     *
     * Note: This is not necessary to use. `useCollection` already unmounts the listener for you. This is only intended if you want to unsubscribe on your own.
     */
    unsubscribe: unsubscribeRef.current,
  }
}
