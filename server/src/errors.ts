/** 统一业务错误：携带 HTTP 状态码与机器可读错误码，由全局错误中间件转为 { ok:false, error, message } */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
