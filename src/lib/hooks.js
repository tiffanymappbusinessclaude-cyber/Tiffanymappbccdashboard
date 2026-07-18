import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase.js";

/**
 * useSupabaseTable — fetch all rows from a table scoped to an agency
 * Usage: const { data, loading, error } = useSupabaseTable("tasks", agencyId)
 */
export function useSupabaseTable(tableName, agencyId, options = {}) {
  const { orderBy = "created_at", ascending = false, filters = [] } = options;
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!tableName) return;
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        let query = supabase.from(tableName).select("*");

        // Apply agency scoping if agencyId exists and table likely has it
        if (agencyId) {
          query = query.eq("agency_id", agencyId);
        }

        // Apply any extra filters
        for (const { col, op, val } of filters) {
          query = query.filter(col, op, val);
        }

        if (orderBy) {
          query = query.order(orderBy, { ascending });
        }

        const { data: rows, error: err } = await query;
        if (cancelled) return;
        if (err) throw err;
        setData(rows || []);
      } catch (err) {
        if (!cancelled) setError(err.message || "Query failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, [tableName, agencyId, JSON.stringify(filters)]);

  return { data, loading, error, setData };
}

/**
 * useSupabaseQuery — polymorphic hook accepting either signature:
 *
 * Legacy:            useSupabaseQuery(queryFn, deps = [])
 * React-query-style: useSupabaseQuery(queryKey, queryFn, options = {})
 */
export function useSupabaseQuery(...args) {
  const isReactQueryStyle = !(typeof args[0] === "function");

  let queryFn;
  let deps;
  let enabled = true;

  if (isReactQueryStyle) {
    const queryKey = args[0];
    queryFn = args[1];
    const opts = args[2] || {};
    enabled = opts.enabled !== false;
    deps = Array.isArray(queryKey) ? queryKey : [queryKey];
  } else {
    queryFn = args[0];
    deps = args[1] || [];
  }

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const refetchRef = useRef(0);

  const refetch = () => {
    refetchRef.current += 1;
    setLoading(true);
    runQuery();
  };

  async function runQuery() {
    if (!enabled) {
      setData(null); setLoading(false); setError(null); return;
    }
    if (typeof queryFn !== "function") {
      setError("useSupabaseQuery: queryFn is not a function"); setLoading(false); return;
    }
    setError(null);
    try {
      const result = await queryFn();
      if (result && typeof result === "object" && "data" in result && "error" in result) {
        if (result.error) throw result.error;
        setData(result.data);
      } else {
        setData(result);
      }
    } catch (err) {
      setError(err?.message || String(err) || "Query failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!enabled) {
        if (!cancelled) { setData(null); setLoading(false); setError(null); }
        return;
      }
      if (typeof queryFn !== "function") {
        if (!cancelled) { setError("useSupabaseQuery: queryFn is not a function"); setLoading(false); }
        return;
      }
      setLoading(true); setError(null);
      try {
        const result = await queryFn();
        if (cancelled) return;
        if (result && typeof result === "object" && "data" in result && "error" in result) {
          if (result.error) throw result.error;
          setData(result.data);
        } else {
          setData(result);
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err) || "Query failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, refetchRef.current]);

  return { data, loading, error, refetch, isLoading: loading };
}
